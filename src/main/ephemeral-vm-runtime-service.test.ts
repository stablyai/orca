import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../shared/pairing'
import {
  getEphemeralVmRuntimeStorePath,
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import {
  getEphemeralVmRuntimeFeatureStorePath,
  MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES
} from '../shared/ephemeral-vm-runtime-feature-store'
import {
  cleanupEphemeralVmRuntime,
  provisionEphemeralVmRuntime,
  resumeEphemeralVmRuntime,
  stopEphemeralVmRuntimeCleanup
} from './ephemeral-vm-runtime-service'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'

const tempDirs: string[] = []

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makePairingCode(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://sandbox.example.com',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

describe('ephemeral VM runtime service', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    // Why: secure-file has dedicated ACL coverage; these tests focus on lifecycle semantics.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('persists a successful recipe-created runtime and cleans it up', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const startPath = join(repoPath, 'start.js')
    const cleanupPath = join(repoPath, 'cleanup.js')
    writeFileSync(
      startPath,
      [
        'console.log(JSON.stringify({',
        '  schemaVersion: 1,',
        `  pairingCode: ${JSON.stringify(makePairingCode())},`,
        "  projectRoot: '/workspace/repo',",
        '  userData: { providerResourceId: process.env.ORCA_VM_INSTANCE_ID }',
        '}))'
      ].join('\n')
    )
    writeFileSync(
      cleanupPath,
      [
        "let input = ''",
        "process.stdin.on('data', (chunk) => { input += chunk })",
        "process.stdin.on('end', () => {",
        '  const payload = JSON.parse(input)',
        '  if (payload.recipeResult.projectRoot !== "/workspace/repo") process.exit(12)',
        '  if (!payload.recipeResult.userData.providerResourceId) process.exit(13)',
        "  require('fs').appendFileSync('cleanup-count.txt', 'x')",
        '  console.error(`cleanup:${payload.instanceId}`)',
        '})'
      ].join('\n')
    )
    const recipe: OrcaVmRecipe = {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      // Repo-owned recipes predate plugin bounds; snapshotting must not fail
      // after create has already provisioned external resources.
      description: 'x'.repeat(2_048),
      create: nodeCommand(startPath),
      destroy: nodeCommand(cleanupPath)
    }

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      repoId: 'repo-1',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      now: 1_000
    })

    expect(provisioned.ok).toBe(true)
    if (!provisioned.ok) {
      throw new Error(provisioned.start.error)
    }
    expect(provisioned.runtime).toMatchObject({
      id: provisioned.start.context.instanceId,
      recipeId: 'cloud-sandbox',
      recipe,
      repoId: 'repo-1',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1_000,
      updatedAt: 1_000
    })
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([provisioned.runtime])

    const cleanupArgs = {
      userDataPath,
      repoPath,
      recipe,
      runtimeId: provisioned.runtime.id,
      now: 2_000
    }
    const [cleanup] = await Promise.all([
      cleanupEphemeralVmRuntime(cleanupArgs),
      cleanupEphemeralVmRuntime(cleanupArgs)
    ])

    expect(cleanup).toMatchObject({
      ok: true,
      skipped: false,
      runtime: {
        id: provisioned.runtime.id,
        status: 'cleaned',
        cleanupStatus: 'succeeded',
        cleanupLastAttemptAt: 2_000
      }
    })
    expect(readFileSync(join(repoPath, 'cleanup-count.txt'), 'utf8')).toBe('x')

    await expect(cleanupEphemeralVmRuntime(cleanupArgs)).resolves.toMatchObject({
      ok: true,
      runtime: { status: 'cleaned' }
    })
    expect(readFileSync(join(repoPath, 'cleanup-count.txt'), 'utf8')).toBe('x')
  })

  it('stops a hung destroy and starts a fresh retry', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const cleanupPath = join(repoPath, 'cleanup.js')
    const countPath = join(repoPath, 'cleanup-count.txt')
    writeFileSync(
      cleanupPath,
      `require('fs').appendFileSync(${JSON.stringify(countPath)}, 'x'); setInterval(() => {}, 1000)`
    )
    const recipe: OrcaVmRecipe = {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      create: 'unused',
      destroy: nodeCommand(cleanupPath)
    }
    upsertEphemeralVmRuntime(userDataPath, {
      id: 'runtime-1',
      recipeId: recipe.id,
      recipe,
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1_000,
      updatedAt: 1_000,
      recipeResult: {
        schemaVersion: 1,
        connection: {
          type: 'ssh',
          projectRoot: '/workspace/repo',
          target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
        }
      }
    })
    const cleanupArgs = {
      userDataPath,
      repoPath,
      recipe,
      runtimeId: 'runtime-1'
    }

    const cleanup = cleanupEphemeralVmRuntime(cleanupArgs)
    await vi.waitFor(() => expect(readFileSync(countPath, 'utf8')).toBe('x'))
    const stopping = stopEphemeralVmRuntimeCleanup({ userDataPath, runtimeId: 'runtime-1' })
    expect(stopping).not.toBeNull()
    await expect(stopping).resolves.toMatchObject({
      ok: false,
      runtime: { status: 'cleanup_failed', cleanupStatus: 'failed' },
      error: 'Cleanup stopped by user.'
    })
    await expect(cleanup).resolves.toMatchObject({ ok: false })
    writeFileSync(cleanupPath, `require('fs').appendFileSync(${JSON.stringify(countPath)}, 'x')`)
    await expect(cleanupEphemeralVmRuntime(cleanupArgs)).resolves.toMatchObject({
      ok: true,
      runtime: { status: 'cleaned', cleanupStatus: 'succeeded' }
    })
    expect(readFileSync(countPath, 'utf8')).toBe('xx')
  })

  it('does not persist a runtime when recipe output cannot be parsed', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const startPath = join(repoPath, 'start.js')
    writeFileSync(startPath, "console.log('not json')\n")

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe: {
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        create: nodeCommand(startPath)
      }
    })

    expect(provisioned).toMatchObject({
      ok: false,
      start: {
        error: 'Recipe stdout must be one JSON object.'
      }
    })
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([])
  })

  it('rejects an unwritable feature store before a checkout-mode recipe creates resources', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const startPath = join(repoPath, 'start.js')
    const markerPath = join(repoPath, 'create-ran.txt')
    writeFileSync(startPath, `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'yes')`)
    const featurePath = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
    writeFileSync(featurePath, '{}')
    truncateSync(featurePath, MAX_EPHEMERAL_VM_RUNTIME_FEATURE_STORE_FILE_BYTES + 1)

    await expect(
      provisionEphemeralVmRuntime({
        userDataPath,
        repoPath,
        recipe: {
          id: 'cloud-sandbox',
          name: 'Cloud Sandbox',
          checkoutMode: 'provisioned-root',
          create: nodeCommand(startPath),
          destroyDisabled: true
        }
      })
    ).rejects.toThrow('Could not preserve ephemeral VM runtime compatibility metadata')
    expect(existsSync(markerPath)).toBe(false)
  })

  it('rejects an unreadable lifecycle store before a checkout-mode recipe creates resources', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const startPath = join(repoPath, 'start.js')
    const markerPath = join(repoPath, 'create-ran.txt')
    writeFileSync(startPath, `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'yes')`)
    writeFileSync(getEphemeralVmRuntimeStorePath(userDataPath), '{')

    await expect(
      provisionEphemeralVmRuntime({
        userDataPath,
        repoPath,
        recipe: {
          id: 'cloud-sandbox',
          name: 'Cloud Sandbox',
          checkoutMode: 'provisioned-root',
          create: nodeCommand(startPath),
          destroyDisabled: true
        }
      })
    ).rejects.toThrow('file is invalid')
    expect(existsSync(markerPath)).toBe(false)
  })

  it('destroys a checkout-mode resource when compatibility persistence fails after create', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const startPath = join(repoPath, 'start.js')
    const cleanupPath = join(repoPath, 'cleanup.js')
    const cleanupMarkerPath = join(repoPath, 'cleanup-ran.txt')
    const featurePath = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
    writeFileSync(
      startPath,
      [
        `require('fs').writeFileSync(${JSON.stringify(featurePath)}, '{')`,
        'console.log(JSON.stringify({',
        '  schemaVersion: 2,',
        '  checkoutMode: "provisioned-root",',
        '  connection: {',
        '    type: "ssh",',
        '    projectRoot: "/workspace/repo",',
        '    target: { label: "VM", host: "host", port: 22, username: "orca" }',
        '  }',
        '}))'
      ].join('\n')
    )
    writeFileSync(
      cleanupPath,
      `require('fs').writeFileSync(${JSON.stringify(cleanupMarkerPath)}, 'yes')`
    )

    await expect(
      provisionEphemeralVmRuntime({
        userDataPath,
        repoPath,
        recipe: {
          id: 'cloud-sandbox',
          name: 'Cloud Sandbox',
          checkoutMode: 'provisioned-root',
          create: nodeCommand(startPath),
          destroy: nodeCommand(cleanupPath)
        }
      })
    ).rejects.toThrow('Could not preserve ephemeral VM runtime compatibility metadata')
    expect(readFileSync(cleanupMarkerPath, 'utf8')).toBe('yes')
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([])
  })

  it('keeps rollback-readable cleanup recovery when post-create destroy also fails', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const startPath = join(repoPath, 'start.js')
    const cleanupPath = join(repoPath, 'cleanup.js')
    const featurePath = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
    writeFileSync(
      startPath,
      [
        `require('fs').writeFileSync(${JSON.stringify(featurePath)}, '{')`,
        'console.log(JSON.stringify({',
        '  schemaVersion: 2,',
        '  checkoutMode: "provisioned-root",',
        '  connection: {',
        '    type: "ssh",',
        '    projectRoot: "/workspace/repo",',
        '    target: { label: "VM", host: "host", port: 22, username: "orca" }',
        '  },',
        '  userData: { providerResourceId: "paid-vm" }',
        '}))'
      ].join('\n')
    )
    writeFileSync(cleanupPath, 'process.exit(1)')

    await expect(
      provisionEphemeralVmRuntime({
        userDataPath,
        repoPath,
        recipe: {
          id: 'cloud-sandbox',
          name: 'Cloud Sandbox',
          checkoutMode: 'provisioned-root',
          create: nodeCommand(startPath),
          destroy: nodeCommand(cleanupPath)
        },
        now: 1_000
      })
    ).rejects.toThrow('Could not preserve ephemeral VM runtime compatibility metadata')
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([
      expect.objectContaining({
        status: 'cleanup_failed',
        cleanupStatus: 'failed',
        recipe: expect.not.objectContaining({ checkoutMode: expect.anything() }),
        recipeResult: expect.objectContaining({
          schemaVersion: 1,
          userData: { providerResourceId: 'paid-vm' }
        })
      })
    ])
  })

  it('destroys a provisioned resource when its checkout handshake is incompatible', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const startPath = join(repoPath, 'start.js')
    const cleanupPath = join(repoPath, 'cleanup.js')
    writeFileSync(
      startPath,
      `console.log(${JSON.stringify(
        JSON.stringify({
          schemaVersion: 1,
          pairingCode: makePairingCode(),
          projectRoot: '/workspace/repo'
        })
      )})`
    )
    writeFileSync(cleanupPath, "require('fs').writeFileSync('cleanup-ran.txt', 'yes')")

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe: {
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        checkoutMode: 'provisioned-root',
        create: nodeCommand(startPath),
        destroy: nodeCommand(cleanupPath)
      }
    })

    expect(provisioned).toMatchObject({
      ok: false,
      start: {
        error:
          'Provisioned-root recipes must return schemaVersion 2 with checkoutMode "provisioned-root".'
      }
    })
    expect(readFileSync(join(repoPath, 'cleanup-ran.txt'), 'utf8')).toBe('yes')
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([])
  })

  it('persists failed cleanup after an incompatible checkout handshake', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const startPath = join(repoPath, 'start.js')
    const cleanupPath = join(repoPath, 'cleanup.js')
    writeFileSync(
      startPath,
      `console.log(${JSON.stringify(
        JSON.stringify({
          schemaVersion: 1,
          pairingCode: makePairingCode(),
          projectRoot: '/workspace/repo'
        })
      )})`
    )
    writeFileSync(cleanupPath, 'process.exit(1)')
    const recipe: OrcaVmRecipe = {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      checkoutMode: 'provisioned-root',
      create: nodeCommand(startPath),
      destroy: nodeCommand(cleanupPath)
    }

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      repoId: 'repo-1',
      workspaceName: 'Fix Login Race',
      now: 1_000
    })

    expect(provisioned.ok).toBe(false)
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([
      expect.objectContaining({
        recipe,
        repoId: 'repo-1',
        workspaceName: 'Fix Login Race',
        status: 'cleanup_failed',
        cleanupStatus: 'failed',
        cleanupLastAttemptAt: 1_000,
        cleanupLastError: expect.any(String)
      })
    ])
  })

  it('persists incompatible resources when destroy is disabled', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const startPath = join(repoPath, 'start.js')
    writeFileSync(
      startPath,
      `console.log(${JSON.stringify(
        JSON.stringify({
          schemaVersion: 1,
          pairingCode: makePairingCode(),
          projectRoot: '/workspace/repo'
        })
      )})`
    )

    await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe: {
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        checkoutMode: 'provisioned-root',
        create: nodeCommand(startPath),
        destroyDisabled: true
      }
    })

    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([
      expect.objectContaining({
        status: 'cleanup_failed',
        cleanupStatus: 'disabled',
        cleanupDisabled: true,
        cleanupLastError: 'Destroy is disabled for this recipe.'
      })
    ])
  })

  it('rejects a provisioned root that moves during resume', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const resumePath = join(repoPath, 'resume.js')
    writeFileSync(
      resumePath,
      [
        'console.log(JSON.stringify({',
        '  schemaVersion: 2,',
        '  checkoutMode: "provisioned-root",',
        '  connection: {',
        '    type: "ssh",',
        '    projectRoot: "/workspace/moved",',
        '    target: { label: "VM", host: "host", port: 22, username: "orca" }',
        '  }',
        '}))'
      ].join('\n')
    )
    const recipe: OrcaVmRecipe = {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      checkoutMode: 'provisioned-root',
      create: 'unused',
      resume: nodeCommand(resumePath),
      destroyDisabled: true
    }
    upsertEphemeralVmRuntime(userDataPath, {
      id: 'runtime-1',
      recipeId: recipe.id,
      recipe,
      status: 'suspended',
      connectionMode: 'ssh',
      cleanupStatus: 'disabled',
      cleanupDisabled: true,
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 2,
        checkoutMode: 'provisioned-root',
        connection: {
          type: 'ssh',
          projectRoot: '/workspace/original',
          target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
        }
      }
    })

    const resumed = await resumeEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      runtimeId: 'runtime-1'
    })

    expect(resumed).toMatchObject({
      ok: false,
      error: 'The provisioned workspace root changed while the runtime was suspended.',
      runtime: {
        status: 'resume_failed',
        recipeResult: { connection: { projectRoot: '/workspace/original' } }
      }
    })
  })

  it('rejects provisioned-root connection-mode drift during resume', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const resumePath = join(repoPath, 'resume.js')
    writeFileSync(
      resumePath,
      `console.log(${JSON.stringify(
        JSON.stringify({
          schemaVersion: 2,
          checkoutMode: 'provisioned-root',
          connection: {
            type: 'orca-server',
            pairingCode: makePairingCode(),
            projectRoot: '/workspace/original'
          }
        })
      )})`
    )
    const recipe: OrcaVmRecipe = {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      checkoutMode: 'provisioned-root',
      create: 'unused',
      resume: nodeCommand(resumePath),
      destroyDisabled: true
    }
    upsertEphemeralVmRuntime(userDataPath, {
      id: 'runtime-1',
      recipeId: recipe.id,
      recipe,
      status: 'suspended',
      connectionMode: 'ssh',
      cleanupStatus: 'disabled',
      cleanupDisabled: true,
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 2,
        checkoutMode: 'provisioned-root',
        connection: {
          type: 'ssh',
          projectRoot: '/workspace/original',
          target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
        }
      }
    })

    const resumed = await resumeEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      runtimeId: 'runtime-1'
    })

    expect(resumed).toMatchObject({
      ok: false,
      error: 'The provisioned workspace connection type changed while the runtime was suspended.',
      runtime: {
        status: 'resume_failed',
        connectionMode: 'ssh',
        recipeResult: { connection: { type: 'ssh' } }
      }
    })
  })
})
