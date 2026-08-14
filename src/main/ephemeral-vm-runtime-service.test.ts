import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../shared/pairing'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import {
  cleanupEphemeralVmRuntime,
  provisionEphemeralVmRuntime,
  resumeEphemeralVmRuntime
} from './ephemeral-vm-runtime-service'
import type { OrcaVmRecipe } from '../shared/types'

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
})
