import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { WorkspaceCleanupWorkspace } from './workspace-cleanup-run-evidence'
import {
  WorktreeRemovalIdentityUnverifiableError,
  type WorktreeCheckoutIdentity
} from '../../../shared/worktree/removal/worktree-checkout-identity'
import { resolveWorkspaceCleanupPolicy } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupRules } from '../../../shared/workspace-cleanup/workspace-cleanup-policy'

const fresh = vi.hoisted((): { workspace: unknown } => ({ workspace: null }))
vi.mock('./workspace-cleanup-run-evidence', () => ({
  collectWorkspaceCleanupWorkspaces: async () => [fresh.workspace]
}))
// Deletion admission hands the removal's own result back; here the route refused to verify.
const admit = vi.hoisted(() =>
  vi.fn(async () => {
    const completion = Promise.reject(new WorktreeRemovalIdentityUnverifiableError())
    completion.catch(() => undefined)
    return { admitted: true, completion }
  })
)
vi.mock('./workspace-cleanup-admission', () => ({ admitWorkspaceCleanup: admit }))
vi.mock('../../workspace-hooks/effective-hooks-reader', () => ({
  getEffectiveHooksAsync: async () => null
}))
vi.mock('./workspace-cleanup-terminal-activity', () => ({
  readWorkspaceCleanupTerminalActivity: async () => 'idle'
}))

import { decideWorkspaceCleanup, removeWorkspaceForCleanup } from './workspace-cleanup-removal-step'
import { createCleanupRemovalRouteCheck } from './workspace-cleanup-removal-route'
import {
  execFileCapture,
  execFileCaptureToTermination
} from '../../git/command-runner/process-capture/exec-file-capture'

const RULES: WorkspaceCleanupRules = {
  merged: { enabled: true },
  unchanged: { enabled: false, afterDays: 1 },
  inactive: { enabled: false, afterDays: 30, action: 'delete' },
  automationRuns: { enabled: false },
  orchestrationWorkers: { enabled: false },
  keepWhen: 'any-local-files'
}

const guard = {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refusal happens before the guard is read.
  identity: { root: '/checkout' } as unknown as WorktreeCheckoutIdentity
}

function wslWorkspace(): WorkspaceCleanupWorkspace {
  const policy = resolveWorkspaceCleanupPolicy({ workspaceCleanupPolicy: RULES }, undefined)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the removal step reads only these fields.
  const workspace = {
    ref: {
      worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\w',
      instanceId: 'instance-1',
      repoId: 'repo',
      repoName: 'repo',
      displayName: 'w',
      branch: 'feature',
      path: '\\\\wsl.localhost\\Ubuntu\\w'
    },
    repo: { id: 'repo', path: '\\\\wsl.localhost\\Ubuntu\\repo' },
    policy,
    input: {
      reasons: ['merged'],
      blockers: [],
      lastActivityAt: 0,
      git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 }
    },
    paneAgentStates: new Map(),
    removing: false,
    identity: 'repo::\\\\wsl.localhost\\Ubuntu\\w',
    folderSiblings: [],
    readPairedFolderChildren: async () => ({ children: [], complete: true })
  } as unknown as WorkspaceCleanupWorkspace
  return workspace
}

let dir: string | undefined
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

/** A command that would leave a marker if Orca let it start. */
function markerCommand(): { marker: string; args: string[] } {
  dir = mkdtempSync(join(tmpdir(), 'orca-identity-unverified-'))
  const marker = join(dir, 'ran')
  return {
    marker,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`]
  }
}

describe('a removal route that cannot verify the checkout keeps it', () => {
  it('refuses a guarded WSL termination-barrier command before it starts', async () => {
    const { marker, args } = markerCommand()
    const onChildTerminated = vi.fn()
    await expect(
      execFileCaptureToTermination(process.execPath, args, {
        worktreeCheckoutGuard: guard,
        onChildTerminated
      })
    ).rejects.toMatchObject({ code: 'ERR_ORCA_WORKTREE_IDENTITY_UNVERIFIABLE' })
    expect(onChildTerminated).toHaveBeenCalledOnce()
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses a guarded command that cannot run on the process worker', async () => {
    const { marker, args } = markerCommand()
    await expect(
      execFileCapture(process.execPath, args, {
        worktreeCheckoutGuard: guard,
        spawnOnWorkerThread: false
      })
    ).rejects.toMatchObject({ code: 'ERR_ORCA_WORKTREE_IDENTITY_UNVERIFIABLE' })
    expect(existsSync(marker)).toBe(false)
  })

  it('keeps a workspace the scan judged before it had an instance id', async () => {
    const stamped = wslWorkspace()
    const { instanceId: _unstamped, ...ref } = stamped.ref
    fresh.workspace = stamped
    admit.mockClear()
    const outcome = await removeWorkspaceForCleanup({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission and evidence are mocked.
      runtime: {} as unknown as OrcaRuntimeService,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission and evidence are mocked.
      store: {} as unknown as RuntimeStore,
      globalRules: () => RULES,
      workspace: { ...stamped, ref },
      now: () => Date.UTC(2026, 10, 20)
    })
    expect(outcome).toEqual({
      outcome: 'kept',
      keepCause: 'identity-unverified',
      keptOnRecheck: true
    })
    expect(admit).not.toHaveBeenCalled()
  })

  it('does not offer a WSL-routed checkout for deletion in the preview or the run', async () => {
    const workspace = wslWorkspace()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a WSL path is decided before the store is read.
    const routeUnverifiable = createCleanupRemovalRouteCheck({} as never)
    expect(routeUnverifiable(workspace.repo, workspace.ref.path)).toBe(true)
    expect(
      await decideWorkspaceCleanup(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route check returns before terminals are read.
        {} as unknown as OrcaRuntimeService,
        { ...workspace, removalRouteUnverifiable: true },
        Date.UTC(2026, 10, 20)
      )
    ).toEqual({ action: 'keep', cause: 'identity-unverified', reason: 'merged' })
  })
})
