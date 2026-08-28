import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import { ControlPlaneStore } from '../orchestration/control-plane/control-plane-store'
import {
  acquireValidationLease,
  releaseValidationLease
} from '../orchestration/control-plane/validation-lease'
import type { OrcaRuntimeService } from '../orca-runtime'
import { RpcDispatcher } from './dispatcher'
import { FILE_METHODS } from './methods/files'
import { GIT_METHODS } from './methods/git'
import { LEASE_FENCED_METHODS } from './validation-lease-fence'

/** MUTATION_UNDER_A_RUNNING_GATE — the validation lease had exactly one
 *  consumer, so every ordinary mutation RPC could edit a worktree while its
 *  gate was still running and the resulting receipt still counted.
 */
describe('MUTATION_UNDER_A_RUNNING_GATE', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    db = undefined
  })

  const commit = vi.fn().mockResolvedValue({ ok: true })
  const write = vi.fn().mockResolvedValue({ ok: true })

  function world(lease: boolean) {
    db = new OrchestrationDb(':memory:')
    if (lease) {
      const acquired = acquireValidationLease(new ControlPlaneStore(db), {
        scopeKey: 'wt:wt-1',
        leaseId: 'lease_1',
        owner: 'dispatch_gate',
        idempotencyKey: 'idem',
        nowMs: Date.now()
      })
      expect(acquired.ok).toBe(true)
    }
    commit.mockClear()
    write.mockClear()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getOrchestrationDb: () => db,
      showManagedTerminalWorkspace: async (selector: string) => ({ id: selector.slice(3) }),
      commitRuntimeGit: commit,
      writeFileExplorerFile: write
    } as unknown as OrcaRuntimeService
    return new RpcDispatcher({ runtime, methods: [...GIT_METHODS, ...FILE_METHODS] })
  }

  const request = (method: string, params: unknown) => ({
    id: 'req-1',
    authToken: 'tok',
    method,
    params
  })

  it('refuses a commit into a worktree under a live validation lease', async () => {
    const dispatcher = world(true)
    const response = await dispatcher.dispatch(
      request('git.commit', { worktree: 'id:wt-1', message: 'sneak it in' })
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'validation_in_progress' } })
    // The point of the fence: the handler never ran, so nothing was mutated.
    expect(commit).not.toHaveBeenCalled()
  })

  it('refuses a file write the same way, from the same one fence', async () => {
    const dispatcher = world(true)
    const response = await dispatcher.dispatch(
      request('files.write', { worktree: 'id:wt-1', relativePath: 'a.ts', content: 'x' })
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'validation_in_progress' } })
    expect(write).not.toHaveBeenCalled()
  })

  it('lets an unleased worktree through untouched', async () => {
    const dispatcher = world(true)
    await dispatcher.dispatch(request('git.commit', { worktree: 'id:wt-2', message: 'fine' }))
    expect(commit).toHaveBeenCalledWith('id:wt-2', 'fine')
  })

  it('negative control: the same commit succeeds once the lease is released', async () => {
    const dispatcher = world(true)
    expect(
      await dispatcher.dispatch(request('git.commit', { worktree: 'id:wt-1', message: 'blocked' }))
    ).toMatchObject({ ok: false })
    releaseValidationLease(new ControlPlaneStore(db!), {
      scopeKey: 'wt:wt-1',
      leaseId: 'lease_1',
      owner: 'dispatch_gate',
      nowMs: Date.now()
    })
    expect(
      await dispatcher.dispatch(request('git.commit', { worktree: 'id:wt-1', message: 'allowed' }))
    ).toMatchObject({ ok: true })
    expect(commit).toHaveBeenCalledWith('id:wt-1', 'allowed')
  })

  it('is inert when no lease exists at all', async () => {
    const dispatcher = world(false)
    expect(
      await dispatcher.dispatch(request('git.commit', { worktree: 'id:wt-1', message: 'ok' }))
    ).toMatchObject({ ok: true })
  })

  it('fences every mutating git and files method, and no read', () => {
    const mutating = ['git.commit', 'git.push', 'files.write', 'files.delete', 'terminal.send']
    const reads = ['git.status', 'files.list', 'files.open', 'terminal.wait']
    expect(mutating.filter((method) => LEASE_FENCED_METHODS.has(method))).toEqual(mutating)
    expect(reads.filter((method) => LEASE_FENCED_METHODS.has(method))).toEqual([])
  })
})

/** "COULD NOT CHECK" MUST NEVER READ AS "CLEAR" — the fence originally wrapped
 *  the whole lookup in one catch, so any database error silently disabled it
 *  and every mutation sailed through. Only "this runtime has no orchestration
 *  database at all" is a legitimate reason to skip the check. */
describe('the lease fence fails open only when there is nothing to fence', () => {
  const request = {
    id: 'r',
    authToken: 't',
    method: 'git.commit',
    params: { worktree: 'id:wt-1', message: 'probe' }
  }

  function dispatcherWith(getOrchestrationDb: () => unknown) {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getOrchestrationDb,
      showManagedTerminalWorkspace: async (s: string) => ({ id: s.slice(3) }),
      commitRuntimeGit: async () => ({ ok: true })
    } as unknown as OrcaRuntimeService
    return new RpcDispatcher({ runtime, methods: [...GIT_METHODS] })
  }

  // These assert only that the FENCE did not fire; the mock runtime is too thin
  // for the handler itself to succeed, and that is not what is under test.
  const fenced = (response: { ok: boolean; error?: { code?: string } }) =>
    response.ok === false && response.error?.code === 'validation_in_progress'

  it('skips the fence when the runtime has no orchestration database', async () => {
    expect(fenced(await dispatcherWith(() => null).dispatch(request))).toBe(false)
  })

  it('skips the fence when asking for the database throws', async () => {
    const dispatcher = dispatcherWith(() => {
      throw new Error('orchestration disabled')
    })
    expect(fenced(await dispatcher.dispatch(request))).toBe(false)
  })

  it('does NOT wave the mutation through when the lease probe itself fails', async () => {
    // A database that exists but cannot answer proves nothing about leases, so
    // "could not check" must not read as "clear".
    const broken = {
      db: {
        exec: () => undefined,
        prepare: () => {
          throw new Error('db is sick')
        }
      }
    }
    const response = await dispatcherWith(() => broken).dispatch(request)
    expect(response.ok).toBe(false)
    expect(response.ok === false && response.error.message).toContain('db is sick')
  })
})

/** A mutating method missing from the list is unfenced, which is the exact
 *  failure a single central fence exists to prevent. This pins the list against
 *  the real registries so a newly added mutation cannot quietly skip it. */
describe('the fenced list stays exhaustive against the real method registries', () => {
  // Read-only by name and by handler: these inspect, they do not mutate.
  const READ_ONLY = new Set([
    'git.status',
    'git.history',
    'git.branchCompare',
    'git.commitCompare',
    'git.localBranches',
    'git.upstreamStatus',
    'git.submoduleStatus',
    'git.checkIgnored',
    'git.remoteCommitUrl',
    'git.remoteFileUrl',
    // Writes only to .git, never to the working tree a gate is reading.
    'git.fetch',
    'git.diff',
    'git.branchDiff',
    'git.commitDiff',
    // Compose text for the user; they touch no path in the tree.
    'git.generateCommitMessage',
    'git.discoverCommitMessageModels',
    'git.cancelGenerateCommitMessage',
    'git.generatePullRequestFields',
    'git.cancelGeneratePullRequestFields',
    'files.list',
    'files.listAll',
    'files.listMarkdownDocuments',
    'files.listDir',
    'files.readDir',
    'files.browseServerDir',
    'files.searchPaths',
    'files.search',
    'files.open',
    'files.openDiff',
    'files.read',
    'files.readPreview',
    'files.readChunk',
    'files.stat',
    'files.watch',
    'files.unwatch',
    'files.resolveTerminalPath',
    'files.readTerminalArtifact',
    'files.readTerminalArtifactPreview'
  ])

  it('fences every mutating git and files method that exists', () => {
    const all = [...GIT_METHODS, ...FILE_METHODS].map((method) => method.name)
    const unfenced = all.filter((name) => !READ_ONLY.has(name) && !LEASE_FENCED_METHODS.has(name))
    expect(unfenced).toEqual([])
  })

  it('does not fence a read', () => {
    for (const name of READ_ONLY) {
      expect(LEASE_FENCED_METHODS.has(name)).toBe(false)
    }
  })
})
