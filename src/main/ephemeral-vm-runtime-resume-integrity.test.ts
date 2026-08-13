import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../shared/pairing'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'

const { resumeRecipe } = vi.hoisted(() => ({ resumeRecipe: vi.fn() }))

vi.mock('./ephemeral-vm-recipe-runner', () => ({
  runEphemeralVmRecipeCleanup: vi.fn(),
  runEphemeralVmRecipeResume: resumeRecipe,
  runEphemeralVmRecipeStart: vi.fn(),
  runEphemeralVmRecipeSuspend: vi.fn()
}))

import { resumeEphemeralVmRuntime } from './ephemeral-vm-runtime-service'

const tempDirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-vm-resume-integrity-'))
  tempDirs.push(dir)
  return dir
}

function pairingCode(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'wss://runtime.example.com',
    deviceToken: 'token',
    publicKeyB64: 'public-key'
  })
}

function provisionedResult(projectRoot: string, resourceId: string) {
  return {
    schemaVersion: 2 as const,
    checkoutMode: 'provisioned-root' as const,
    pairingCode: pairingCode(),
    projectRoot,
    userData: { resourceId }
  }
}

const provisionedRecipe = {
  id: 'cloud-sandbox',
  name: 'Cloud Sandbox',
  create: './create.sh',
  resume: './resume.sh',
  checkoutMode: 'provisioned-root' as const
}

function persistRuntime(userDataPath: string, withImmutableRoot = true, withRecipe = true): void {
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-1',
    recipeId: 'cloud-sandbox',
    ...(withRecipe ? { recipe: provisionedRecipe } : {}),
    repoId: 'repo-1',
    ...(withImmutableRoot ? { provisionedProjectRoot: '/workspace/repo' } : {}),
    connectionMode: 'orca-server',
    status: 'suspended',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: provisionedResult('/workspace/repo', 'old-resource')
  })
}

describe('ephemeral VM resume integrity', () => {
  beforeEach(() => resumeRecipe.mockReset())

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('retains a parsed failure result as the newest cleanup handle', async () => {
    const userDataPath = makeDir()
    persistRuntime(userDataPath, false)
    resumeRecipe.mockResolvedValue({
      ok: false,
      skipped: false,
      context: {},
      error: 'checkout mode mismatch',
      stdout: '',
      stderr: '',
      exitCode: 0,
      signal: null,
      recipeResult: {
        schemaVersion: 1,
        pairingCode: pairingCode(),
        projectRoot: '/workspace/repo',
        userData: { resourceId: 'replacement-resource' }
      }
    })

    const result = await resumeEphemeralVmRuntime({
      userDataPath,
      repoPath: '/repo',
      recipe: listEphemeralVmRuntimes(userDataPath)[0]!.recipe!,
      runtimeId: 'runtime-1'
    })

    expect(result).toMatchObject({
      ok: false,
      runtime: {
        status: 'resume_failed',
        provisionedProjectRoot: '/workspace/repo',
        recipeResult: { userData: { resourceId: 'replacement-resource' } }
      }
    })

    resumeRecipe.mockResolvedValue({
      ok: true,
      skipped: false,
      context: {},
      result: provisionedResult('/workspace/moved', 'next-resource'),
      stdout: '',
      stderr: ''
    })
    await expect(
      resumeEphemeralVmRuntime({
        userDataPath,
        repoPath: '/repo',
        recipe: listEphemeralVmRuntimes(userDataPath)[0]!.recipe!,
        runtimeId: 'runtime-1'
      })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('projectRoot stable') })
  })

  it('rejects a moved provisioned root without ever persisting running status', async () => {
    const userDataPath = makeDir()
    persistRuntime(userDataPath)
    resumeRecipe.mockResolvedValue({
      ok: true,
      skipped: false,
      context: {},
      result: provisionedResult('/workspace/moved', 'new-resource'),
      stdout: '',
      stderr: ''
    })

    const result = await resumeEphemeralVmRuntime({
      userDataPath,
      repoPath: '/repo',
      recipe: listEphemeralVmRuntimes(userDataPath)[0]!.recipe!,
      runtimeId: 'runtime-1'
    })

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('projectRoot stable'),
      runtime: {
        status: 'resume_failed',
        provisionedProjectRoot: '/workspace/repo',
        recipeResult: { projectRoot: '/workspace/moved' }
      }
    })
  })

  it('persists connection publication before returning provider resume success', async () => {
    const userDataPath = makeDir()
    persistRuntime(userDataPath)
    resumeRecipe.mockResolvedValue({
      ok: true,
      skipped: false,
      context: {},
      result: provisionedResult('/workspace/repo', 'new-resource'),
      stdout: '',
      stderr: ''
    })

    await expect(
      resumeEphemeralVmRuntime({
        userDataPath,
        repoPath: '/repo',
        recipe: provisionedRecipe,
        runtimeId: 'runtime-1'
      })
    ).resolves.toMatchObject({
      ok: true,
      runtime: { status: 'running', resumeConnectionPending: true }
    })
  })

  it('rejects a moved root for a legacy runtime without a recipe snapshot', async () => {
    const userDataPath = makeDir()
    persistRuntime(userDataPath, false, false)
    resumeRecipe.mockResolvedValue({
      ok: true,
      skipped: false,
      context: {},
      result: provisionedResult('/workspace/moved', 'new-resource'),
      stdout: '',
      stderr: ''
    })

    const result = await resumeEphemeralVmRuntime({
      userDataPath,
      repoPath: '/repo',
      recipe: provisionedRecipe,
      runtimeId: 'runtime-1'
    })

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('projectRoot stable'),
      runtime: {
        status: 'resume_failed',
        provisionedProjectRoot: '/workspace/repo'
      }
    })
  })

  it('rejects a connection-type change and retains its cleanup handle', async () => {
    const userDataPath = makeDir()
    persistRuntime(userDataPath)
    resumeRecipe.mockResolvedValue({
      ok: true,
      skipped: false,
      context: {},
      result: {
        schemaVersion: 2,
        checkoutMode: 'provisioned-root',
        connection: {
          type: 'ssh',
          projectRoot: '/workspace/repo',
          target: { label: 'box', host: 'host', port: 22, username: 'orca' }
        },
        userData: { resourceId: 'ssh-resource' }
      },
      stdout: '',
      stderr: ''
    })

    const result = await resumeEphemeralVmRuntime({
      userDataPath,
      repoPath: '/repo',
      recipe: listEphemeralVmRuntimes(userDataPath)[0]!.recipe!,
      runtimeId: 'runtime-1'
    })

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('connection type stable'),
      runtime: {
        status: 'resume_failed',
        recipeResult: { userData: { resourceId: 'ssh-resource' } }
      }
    })
  })
})
