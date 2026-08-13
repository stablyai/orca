import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../shared/pairing'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import {
  cleanupEphemeralVmRuntime,
  provisionEphemeralVmRuntime
} from './ephemeral-vm-runtime-service'
import { attachEphemeralVmRuntimeToWorkspace } from './ephemeral-vm-runtime-attachment'
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
        '  userData: {',
        '    providerResourceId: process.env.ORCA_VM_INSTANCE_ID,',
        '    repoUrl: process.env.ORCA_REPO_URL',
        '  }',
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
      checkoutMode: 'orca-worktree',
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
      repoUrl: 'https://token@git.example.com/team/repo.git?signature=secret',
      now: 1_000
    })

    expect(provisioned.ok).toBe(true)
    if (!provisioned.ok) {
      throw new Error(provisioned.start.error)
    }
    expect(provisioned.runtime).toMatchObject({
      id: provisioned.start.context.instanceId,
      recipeId: 'cloud-sandbox',
      repoId: 'repo-1',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      repoUrl: 'https://git.example.com/team/repo.git',
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1_000,
      updatedAt: 1_000
    })
    expect(provisioned.runtime.recipeResult.userData).toMatchObject({
      repoUrl: 'https://git.example.com/team/repo.git'
    })
    expect(provisioned.runtime.recipe).not.toHaveProperty('checkoutMode')
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
    expect(() =>
      attachEphemeralVmRuntimeToWorkspace({
        userDataPath,
        runtimeId: provisioned.runtime.id,
        workspaceId: 'late-workspace'
      })
    ).toThrow('Cannot attach cleaned ephemeral VM runtime')
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
})
