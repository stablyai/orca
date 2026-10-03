import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePluginMarkdownSource } from '../plugins/plugin-markdown-source'
import type {
  TerminalWorkspaceLookupOptions,
  TerminalWorkspaceLaunchScope
} from './runtime-legacy-worker-terminal-recovery-types'

const materialize = vi.hoisted(() => vi.fn())
vi.mock('./runtime-terminal-spawn-push-target-materialization', () => ({
  triggerTerminalSpawnPushTargetMaterialization: materialize
}))
vi.mock('./orca-runtime-transition-graph-reload-to-terminal-state', () => ({
  OrcaRuntimeWithTransitionGraphReloadToTerminalState: class {}
}))
vi.mock('./orca-runtime-restore-structured-agent-session-tabs-once', () => ({
  OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce: class {}
}))
vi.mock('./orca-runtime-postlude', () => ({ DEFAULT_WORKTREE_LIST_LIMIT: 50 }))
import { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree } from './orca-runtime-resolve-browser-network-execution-host-for-worktree'
import { OrcaRuntimeWithListManagedWorktrees } from './orca-runtime-list-managed-worktrees'

const roots: string[] = []
beforeEach(() => materialize.mockClear())
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-markdown-readonly-'))
  roots.push(root)
  const workspace = join(root, 'notes')
  await mkdir(workspace)
  const documentPath = join(workspace, 'a.md')
  await writeFile(documentPath, '# A')
  const repo = { id: 'repo', path: workspace, displayName: 'Notes', badgeColor: '', addedAt: 0 }
  const worktree = {
    id: 'repo::notes',
    repoId: 'repo',
    hostId: 'local',
    path: workspace,
    pushTarget: {
      remoteUrl: 'https://example.com/provider/repo.git',
      remoteName: 'provider',
      remoteCreated: false
    }
  }
  const prototype = OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree.prototype
  const scope = Reflect.get(prototype, 'resolveTerminalWorkspaceLaunchScope')
  const target = Reflect.get(prototype, 'resolveTerminalWorkspaceLaunchTarget')
  if (typeof scope !== 'function' || typeof target !== 'function') {
    throw new Error('missing runtime scope methods')
  }
  const host = {
    store: { getRepos: () => [repo], getRepo: () => repo },
    resolveFolderWorkspaceLaunchScope: async () => null,
    resolveWorktreeSelector: vi.fn(async () => worktree),
    resolveTerminalWorkspaceLaunchTarget: (
      selector: string,
      created: unknown,
      options: TerminalWorkspaceLookupOptions
    ) => Reflect.apply(target, host, [selector, created, options]),
    resolveTerminalWorkspaceLaunchScope: (
      selector: string,
      created: unknown,
      options: TerminalWorkspaceLookupOptions
    ) => Reflect.apply(scope, host, [selector, created, options])
  }
  const show = (
    selector: string,
    options?: TerminalWorkspaceLookupOptions
  ): Promise<TerminalWorkspaceLaunchScope> =>
    Reflect.apply(
      OrcaRuntimeWithListManagedWorktrees.prototype.showTerminalWorkspaceLaunchScope,
      host,
      [selector, options]
    )
  return { host, worktree, show, documentPath }
}

describe('Markdown read-only workspace lookup', () => {
  it('resolves a source with a deferred push target without Git materialization', async () => {
    const f = await fixture()
    expect(
      await resolvePluginMarkdownSource(
        { getRuntimeId: () => 'runtime', showTerminalWorkspaceLaunchScope: f.show },
        {
          fileId: 'file',
          documentPath: f.documentPath,
          worktreeId: f.worktree.id,
          runtimeEnvironmentId: null
        }
      )
    ).toMatchObject({ status: 'resolved' })
    expect(f.host.resolveWorktreeSelector).toHaveBeenCalledWith('id:repo::notes')
    expect(materialize).not.toHaveBeenCalled()
  })

  it('preserves the default materialization behavior for terminal scope callers', async () => {
    const f = await fixture()
    expect(await f.show('id:repo::notes')).toMatchObject({ id: 'repo::notes' })
    expect(materialize).toHaveBeenCalledOnce()
    expect(materialize).toHaveBeenCalledWith(
      f.worktree.path,
      f.worktree.pushTarget,
      expect.objectContaining({ id: 'repo' }),
      f.host.store,
      'repo',
      'repo::notes'
    )
  })

  it('preserves an explicit remote host despite local repository metadata and refuses local reads', async () => {
    const f = await fixture()
    f.worktree.hostId = 'runtime:remote'
    expect(await f.show('id:repo::notes', { materializePushTarget: false })).toMatchObject({
      executionHostId: 'runtime:remote'
    })
    expect(
      await resolvePluginMarkdownSource(
        { getRuntimeId: () => 'runtime', showTerminalWorkspaceLaunchScope: f.show },
        {
          fileId: 'file',
          documentPath: f.documentPath,
          worktreeId: f.worktree.id,
          runtimeEnvironmentId: null
        }
      )
    ).toMatchObject({ status: 'unavailable' })
    expect(materialize).not.toHaveBeenCalled()
  })
})
