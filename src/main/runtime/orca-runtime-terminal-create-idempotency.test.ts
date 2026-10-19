import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { describe, expect, it, vi } from 'vitest'
import type { PtyProcessInfo } from '../providers/pty-provider-contract'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { RuntimeTerminalSplit } from '../../shared/runtime-terminal-contracts'
import { OrcaRuntimeService } from './orca-runtime'
import { deriveRemoteRuntimeTerminalCreateHandle } from './remote-runtime-terminal-create-identity'
import { RemoteRuntimeTerminalCreateIdempotency } from './remote-runtime-terminal-create-idempotency'

type CreateRun = (
  canonicalWorktreeSelector: string | undefined,
  preAllocatedHandle: string | undefined
) => Promise<RuntimeTerminalCreate>

function createRuntimeForDedupe(
  listProcesses = vi.fn(async (): Promise<PtyProcessInfo[]> => []),
  scope: { connectionId?: string | null } = {}
) {
  const handleByPtyId = new Map<string, string>()
  const runtime = Object.create(OrcaRuntimeService.prototype) as OrcaRuntimeService
  Object.assign(runtime, {
    terminalCreateIdempotency: new RemoteRuntimeTerminalCreateIdempotency(),
    ptyController: { listProcesses },
    resolveTerminalWorkspaceLaunchScope: vi.fn(async (selector: string) => ({
      id: selector.startsWith('id:') ? selector.slice(3) : selector,
      ...scope
    })),
    adoptControllerTerminalHandle: vi.fn((ptyId: string, handle: string) => {
      handleByPtyId.set(ptyId, handle)
    }),
    recordPtyWorktree: vi.fn((ptyId: string, worktreeId: string, state: { title?: string }) => ({
      ptyId,
      worktreeId,
      title: state.title ?? null
    })),
    issuePtyHandle: vi.fn((pty: { ptyId: string }) => handleByPtyId.get(pty.ptyId))
  })
  return { runtime, listProcesses }
}

function createdTerminal(handle: string, worktreeId = 'worktree-1'): RuntimeTerminalCreate {
  return { handle, worktreeId, title: null }
}

describe('terminal create idempotency', () => {
  it('derives a stable handle isolated by authenticated client and canonical worktree', () => {
    const first = deriveRemoteRuntimeTerminalCreateHandle('device-a', 'worktree-1', 'mutation-1')

    expect(deriveRemoteRuntimeTerminalCreateHandle('device-a', 'worktree-1', 'mutation-1')).toBe(
      first
    )
    expect(
      deriveRemoteRuntimeTerminalCreateHandle('device-b', 'worktree-1', 'mutation-1')
    ).not.toBe(first)
    expect(
      deriveRemoteRuntimeTerminalCreateHandle('device-a', 'worktree-2', 'mutation-1')
    ).not.toBe(first)
    expect(first).toMatch(/^term_[0-9a-f]{32}$/)
  })

  it('shares an in-flight create without scanning inventory on the initial request', async () => {
    const { runtime, listProcesses } = createRuntimeForDedupe()
    let resolveCreate: (value: RuntimeTerminalCreate) => void = () => {}
    const pending = new Promise<RuntimeTerminalCreate>((resolve) => {
      resolveCreate = resolve
    })
    const create = vi.fn<CreateRun>(() => pending)

    const first = runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      'mutation-1',
      false,
      create
    )
    const retry = runtime.dedupeTerminalCreate(
      'device-a',
      'worktree-1',
      'mutation-1',
      false,
      create
    )
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const stableHandle = create.mock.calls[0][1]
    resolveCreate(createdTerminal(stableHandle ?? 'missing'))

    await expect(Promise.all([first, retry])).resolves.toEqual([
      createdTerminal(stableHandle ?? 'missing'),
      createdTerminal(stableHandle ?? 'missing')
    ])
    expect(listProcesses).not.toHaveBeenCalled()
  })

  it('adopts the original PTY after a runtime-process restart without rerunning startup', async () => {
    const liveSessions: PtyProcessInfo[] = []
    const firstRuntime = createRuntimeForDedupe(vi.fn(async () => liveSessions)).runtime
    const secondInventory = vi.fn(async () => liveSessions)
    const secondRuntime = createRuntimeForDedupe(secondInventory).runtime
    const startup = vi.fn<CreateRun>(async (_selector, handle) => {
      liveSessions.push({
        id: 'worktree-1@@session-a',
        cwd: '/workspace',
        title: 'pwsh',
        worktreeId: 'worktree-1',
        terminalHandle: handle
      })
      return createdTerminal(handle ?? 'missing')
    })

    const first = await firstRuntime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      'mutation-1',
      false,
      startup
    )
    const retrySpawn = vi.fn<CreateRun>()
    const recovered = await secondRuntime.dedupeTerminalCreate(
      'device-a',
      'worktree-1',
      'mutation-1',
      true,
      retrySpawn
    )

    expect(recovered.handle).toBe(first.handle)
    expect(recovered.ptyId).toBe('worktree-1@@session-a')
    expect(startup).toHaveBeenCalledTimes(1)
    expect(retrySpawn).not.toHaveBeenCalled()
    expect(secondInventory).toHaveBeenCalledTimes(1)
  })

  it('creates with the same stable handle after authoritative inventory proves absence', async () => {
    const { runtime, listProcesses } = createRuntimeForDedupe()
    const create = vi.fn<CreateRun>(async (_selector, handle) =>
      createdTerminal(handle ?? 'missing')
    )

    const result = await runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      'mutation-1',
      true,
      create
    )

    expect(listProcesses).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith('id:worktree-1', result.handle)
  })

  it('fails safely without spawning when retry inventory is unavailable', async () => {
    const listProcesses = vi.fn(async (): Promise<PtyProcessInfo[]> => {
      throw new Error('controller offline')
    })
    const { runtime } = createRuntimeForDedupe(listProcesses)
    const create = vi.fn<CreateRun>()

    await expect(
      runtime.dedupeTerminalCreate('device-a', 'id:worktree-1', 'mutation-1', true, create)
    ).rejects.toThrow('runtime_unavailable')
    expect(create).not.toHaveBeenCalled()
  })

  it('fails safely when an older provider omits identity for a live same-worktree PTY', async () => {
    const { runtime } = createRuntimeForDedupe(
      vi.fn(async () => [
        {
          id: 'worktree-1@@legacy-session',
          cwd: '/workspace',
          title: 'shell',
          worktreeId: 'worktree-1'
        }
      ])
    )
    const create = vi.fn<CreateRun>()

    await expect(
      runtime.dedupeTerminalCreate('device-a', 'id:worktree-1', 'mutation-1', true, create)
    ).rejects.toThrow('runtime_unavailable')
    expect(create).not.toHaveBeenCalled()
  })

  it('adopts an exact identity even when another legacy PTY lacks metadata', async () => {
    const handle = deriveRemoteRuntimeTerminalCreateHandle('device-a', 'worktree-1', 'mutation-1')
    const { runtime } = createRuntimeForDedupe(
      vi.fn(async () => [
        {
          id: 'worktree-1@@legacy-session',
          cwd: '/workspace',
          title: 'shell',
          worktreeId: 'worktree-1'
        },
        {
          id: 'worktree-1@@created-session',
          cwd: '/workspace',
          title: 'pwsh',
          worktreeId: 'worktree-1',
          terminalHandle: handle
        }
      ])
    )

    await expect(
      runtime.dedupeTerminalCreate(
        'device-a',
        'id:worktree-1',
        'mutation-1',
        true,
        vi.fn<CreateRun>()
      )
    ).resolves.toMatchObject({ handle, ptyId: 'worktree-1@@created-session' })
  })

  it('fails closed when a matching handle belongs to another worktree', async () => {
    const handle = deriveRemoteRuntimeTerminalCreateHandle('device-a', 'worktree-1', 'mutation-1')
    const { runtime } = createRuntimeForDedupe(
      vi.fn(async () => [
        {
          id: 'worktree-2@@session-a',
          cwd: '/other',
          title: 'shell',
          worktreeId: 'worktree-2',
          terminalHandle: handle
        }
      ])
    )
    const create = vi.fn<CreateRun>()

    await expect(
      runtime.dedupeTerminalCreate('device-a', 'id:worktree-1', 'mutation-1', true, create)
    ).rejects.toThrow('terminal_create_identity_conflict')
    expect(create).not.toHaveBeenCalled()
  })

  it('bounds concurrent creates and releases capacity after settlement', async () => {
    const idempotency = new RemoteRuntimeTerminalCreateIdempotency(1)
    let resolveFirst: (value: RuntimeTerminalCreate) => void = () => {}
    const first = idempotency.run(
      'device-a',
      'worktree-1',
      'mutation-1',
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )

    await expect(
      idempotency.run('device-a', 'worktree-1', 'mutation-2', async () =>
        createdTerminal('terminal-2')
      )
    ).rejects.toThrow('Too many terminal creations')
    resolveFirst(createdTerminal('terminal-1'))
    await first
    await expect(
      idempotency.run('device-a', 'worktree-1', 'mutation-2', async () =>
        createdTerminal('terminal-2')
      )
    ).resolves.toEqual(createdTerminal('terminal-2'))
  })
})

// Mirrors listProcessesFromRuntimeController: `undefined` aggregates every provider and
// silently drops a non-answering SSH host, `local` is local-only, an `ssh:` host is host-scoped
// and rethrows the host's failure.
function createHostScopedInventory(hosts: {
  local?: PtyProcessInfo[]
  ssh?: Record<string, PtyProcessInfo[] | 'unreachable'>
}) {
  const local = hosts.local ?? []
  const ssh = hosts.ssh ?? {}
  return vi.fn(async (hostId?: string): Promise<PtyProcessInfo[]> => {
    if (hostId === 'local') {
      return local
    }
    if (typeof hostId === 'string') {
      const host = ssh[hostId.slice('ssh:'.length)]
      if (host === undefined || host === 'unreachable') {
        throw new Error('ssh relay did not answer')
      }
      return host
    }
    return [
      ...local,
      ...Object.values(ssh)
        .filter((sessions): sessions is PtyProcessInfo[] => sessions !== 'unreachable')
        .flat()
    ]
  })
}

function remoteSession(handle: string | undefined, worktreeId = 'worktree-1'): PtyProcessInfo {
  return {
    id: `${worktreeId}@@session-a`,
    cwd: '/remote/workspace',
    title: 'claude',
    worktreeId,
    ...(handle ? { terminalHandle: handle } : {})
  }
}

describe('terminal create reconciliation scopes inventory to the owning execution host', () => {
  it('reports runtime_unavailable instead of spawning a duplicate when the owning relay cannot answer', async () => {
    const listProcesses = createHostScopedInventory({
      // The first create's shell is alive on ssh-1; the relay simply cannot be asked about it.
      ssh: { 'ssh-1': 'unreachable', 'ssh-2': [remoteSession(undefined, 'worktree-9')] }
    })
    const { runtime } = createRuntimeForDedupe(listProcesses, { connectionId: 'ssh-1' })
    const create = vi.fn<CreateRun>()

    await expect(
      runtime.dedupeTerminalCreate('device-a', 'id:worktree-1', 'mutation-1', true, create)
    ).rejects.toThrow('runtime_unavailable')
    expect(create).not.toHaveBeenCalled()
    expect(listProcesses).toHaveBeenCalledWith('ssh:ssh-1')
  })

  it('adopts the original PTY from the owning host listing', async () => {
    const handle = deriveRemoteRuntimeTerminalCreateHandle('device-a', 'worktree-1', 'mutation-1')
    const listProcesses = createHostScopedInventory({ ssh: { 'ssh-1': [remoteSession(handle)] } })
    const { runtime } = createRuntimeForDedupe(listProcesses, { connectionId: 'ssh-1' })
    const create = vi.fn<CreateRun>()

    await expect(
      runtime.dedupeTerminalCreate('device-a', 'id:worktree-1', 'mutation-1', true, create)
    ).resolves.toMatchObject({ handle, ptyId: 'worktree-1@@session-a' })
    expect(create).not.toHaveBeenCalled()
  })

  it('still creates a fresh terminal when the owning host authoritatively lacks the handle', async () => {
    const listProcesses = createHostScopedInventory({
      ssh: { 'ssh-1': [remoteSession(undefined, 'worktree-other')] }
    })
    const { runtime } = createRuntimeForDedupe(listProcesses, { connectionId: 'ssh-1' })
    const create = vi.fn<CreateRun>(async (_selector, handle) =>
      createdTerminal(handle ?? 'missing')
    )

    const result = await runtime.dedupeTerminalCreate(
      'device-a',
      'id:worktree-1',
      'mutation-1',
      true,
      create
    )

    expect(create).toHaveBeenCalledWith('id:worktree-1', result.handle)
    expect(listProcesses).toHaveBeenCalledWith('ssh:ssh-1')
  })

  it('scopes the listing to the local host for a workspace with no connection', async () => {
    const handle = deriveRemoteRuntimeTerminalCreateHandle('device-a', 'worktree-1', 'mutation-1')
    const listProcesses = createHostScopedInventory({
      local: [{ ...remoteSession(handle), cwd: '/local/workspace', title: 'pwsh' }]
    })
    const { runtime } = createRuntimeForDedupe(listProcesses, { connectionId: null })
    const create = vi.fn<CreateRun>()

    await expect(
      runtime.dedupeTerminalCreate('device-a', 'id:worktree-1', 'mutation-1', true, create)
    ).resolves.toMatchObject({ handle, ptyId: 'worktree-1@@session-a' })
    expect(listProcesses).toHaveBeenCalledWith('local')
    expect(create).not.toHaveBeenCalled()
  })

  it('scopes the listing to the local host for a folder workspace with no connection', async () => {
    const listProcesses = createHostScopedInventory({})
    const { runtime } = createRuntimeForDedupe(listProcesses, { connectionId: null })
    const create = vi.fn<CreateRun>(async (_selector, handle) =>
      createdTerminal(handle ?? 'missing', 'folder:folder-1')
    )

    const result = await runtime.dedupeTerminalCreate(
      'device-a',
      'id:folder:folder-1',
      'mutation-1',
      true,
      create
    )

    expect(create).toHaveBeenCalledWith('id:folder:folder-1', result.handle)
    expect(listProcesses).toHaveBeenCalledWith('local')
  })
})

function scope(): TerminalWorkspaceLaunchScope {
  return {
    id: 'repo::workspace',
    path: '/workspace',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  }
}
function replacement(): never {
  throw new Error('an argument getter replaced an already captured runtime method')
}

describe('launch runtime dispatch and allocation phases', () => {
  it('retains first-Promise behavior when caller operation keys collide', async () => {
    const runtime = new OrcaRuntimeService(null)
    const firstFactory = vi.fn(async () => ({ worktree: 'first' }))
    const secondFactory = vi.fn(async () => ({ agentLaunch: 'second' }))
    const first = runtime.dedupeWorktreeCreate('repo', 'agent.launch:mutation', firstFactory)
    const second = runtime.dedupeWorktreeCreate('repo', 'agent.launch:mutation', secondFactory)
    expect(second).toBe(first)
    await expect(first).resolves.toEqual({ worktree: 'first' })
    expect(firstFactory).toHaveBeenCalledTimes(1)
    expect(secondFactory).not.toHaveBeenCalled()
  })

  it('captures private agent-session reconciliation before identity getters', async () => {
    const runtime = new OrcaRuntimeService(null)
    const result = createdTerminal('reclaimed')
    const events: string[] = []
    Object.defineProperty(runtime, 'reconcileRemoteTerminalCreate', {
      configurable: true,
      get: () => {
        events.push('read-reconcile')
        return async function (this: OrcaRuntimeService, ...args: unknown[]) {
          expect(this).toBe(runtime)
          expect(args).toEqual(['worktree-1', 'reclaimed', null])
          return result
        }
      }
    })
    const identity = {
      get worktreeId() {
        events.push('read-worktree')
        Object.defineProperty(runtime, 'reconcileRemoteTerminalCreate', { value: replacement })
        return 'worktree-1'
      },
      terminalHandle: 'reclaimed',
      connectionId: null
    }
    await expect(runtime['reclaimFencedAgentSessionSpawn'](identity)).resolves.toBe(result)
    expect(events).toEqual(['read-reconcile', 'read-worktree'])
  })

  it('retains direct spawn failure and withdrawal after awaited admission removes spawn', async () => {
    const runtime = new OrcaRuntimeService(null)
    const entered = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const events: string[] = []
    const spawn = vi.fn(async () => {
      throw new Error('removed spawn must not run')
    })
    const controller: Pick<RuntimePtyController, 'spawn'> = { spawn }
    const store = {
      admitTerminalPane: async function () {
        expect(this).toBe(store)
        events.push('admit')
        entered.resolve()
        await ready.promise
        delete controller.spawn
        events.push('removed')
        return 'admitted'
      },
      withdrawTerminalPane: vi.fn(async function (this: typeof store): Promise<void> {
        expect(this).toBe(store)
        events.push('withdraw')
      })
    }
    Object.defineProperty(runtime, 'store', { value: store })
    Object.defineProperty(runtime, 'ptyController', { value: controller })
    Object.defineProperty(runtime, 'getAvailableAuthoritativeWindow', { value: () => null })
    Object.defineProperty(runtime, 'resolveTerminalWorkspaceLaunchScope', {
      value: async () => scope()
    })
    Object.defineProperty(runtime, 'resolveAgentTerminalCreateOptions', {
      value: async (_workspace: unknown, opts: unknown) => opts
    })
    Object.defineProperty(runtime, 'buildTerminalWorkspaceEnv', { value: () => ({}) })
    const pending = runtime.createTerminal('workspace')
    await entered.promise
    expect(events).toEqual(['admit'])
    expect(store.withdrawTerminalPane).not.toHaveBeenCalled()
    ready.resolve()
    await expect(pending).rejects.toBeInstanceOf(TypeError)
    expect(events).toEqual(['admit', 'removed', 'withdraw'])
    expect(store.withdrawTerminalPane).toHaveBeenCalledTimes(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reenters the split override and captures it before the PTY argument getter', async () => {
    const runtime = new OrcaRuntimeService(null)
    const pty = runtime['recordPtyWorktree']('pty', 'repo::workspace')
    const result: RuntimeTerminalSplit = {
      handle: 'split',
      tabId: 'tab',
      leafId: 'leaf',
      paneRuntimeId: 1
    }
    const events: string[] = []
    Object.defineProperty(runtime, 'splitPtyBackedTerminal', {
      configurable: true,
      get: () => {
        events.push('read-split')
        return async function (
          this: OrcaRuntimeService,
          actual: unknown
        ): Promise<RuntimeTerminalSplit> {
          expect(this).toBe(runtime)
          expect(actual).toBe(pty)
          return result
        }
      }
    })
    Object.defineProperty(runtime, 'getLivePtyForHandle', {
      value: () => ({
        record: null,
        get pty() {
          events.push('read-pty')
          Object.defineProperty(runtime, 'splitPtyBackedTerminal', { value: replacement })
          return pty
        }
      })
    })
    await expect(runtime.splitTerminal('handle')).resolves.toBe(result)
    expect(events).toEqual(['read-split', 'read-pty'])
  })

  it('reenters workspace target resolution on the runtime', async () => {
    const runtime = new OrcaRuntimeService(null)
    const workspace = scope()
    Object.defineProperty(runtime, 'resolveTerminalWorkspaceLaunchTarget', {
      value: async function (this: OrcaRuntimeService, selector: string) {
        expect(this).toBe(runtime)
        expect(selector).toBe('folder')
        return { scope: workspace, managedWorktree: null }
      }
    })
    await expect(runtime['resolveTerminalWorkspaceLaunchScope']('folder')).resolves.toBe(workspace)
  })

  it('reads reconciliation and its canonical cache after workspace resolution', async () => {
    const runtime = new OrcaRuntimeService(null)
    const ready = Promise.withResolvers<TerminalWorkspaceLaunchScope>()
    const result: RuntimeTerminalCreate = {
      handle: 'adopted',
      worktreeId: 'repo::workspace',
      title: null
    }
    Object.defineProperty(runtime, 'resolveTerminalWorkspaceLaunchScope', {
      value: () => ready.promise
    })
    const run = vi.fn(async () => result)
    const pending = runtime.dedupeTerminalCreate('device', 'workspace', 'mutation', true, run)
    const events: string[] = []
    Object.defineProperty(runtime, 'reconcileRemoteTerminalCreate', {
      value: async function (
        this: OrcaRuntimeService,
        worktreeId: string,
        _handle: string,
        connection: null
      ) {
        expect(this).toBe(runtime)
        expect(worktreeId).toBe('repo::workspace')
        expect(connection).toBeNull()
        events.push('reconcile')
        return result
      }
    })
    const cache = runtime['terminalCreateIdempotency']
    Object.defineProperty(runtime, 'terminalCreateIdempotency', {
      get: () => {
        events.push('read-cache')
        return cache
      }
    })
    ready.resolve(scope())
    await expect(pending).resolves.toBe(result)
    expect(events).toEqual(['read-cache', 'reconcile'])
    expect(run).not.toHaveBeenCalled()
  })

  it('captures startup and create overrides before option getters', async () => {
    const runtime = new OrcaRuntimeService(null)
    const repo = {
      id: 'repo',
      path: '/workspace',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    }
    const terminal: RuntimeTerminalCreate = {
      handle: 'terminal',
      worktreeId: 'repo::workspace',
      title: null
    }
    Object.defineProperty(runtime, 'store', {
      value: { getRepos: () => [repo], getRepo: () => repo }
    })
    Object.defineProperty(runtime, 'resolveWorktreeSelector', {
      value: async () => ({ id: 'repo::workspace', repoId: 'repo', path: '/workspace' })
    })
    const events: string[] = []
    Object.defineProperty(runtime, 'buildStartupForAgent', {
      configurable: true,
      get: () => {
        events.push('read-startup')
        return function (this: OrcaRuntimeService) {
          expect(this).toBe(runtime)
          return { agent: 'codex', startup: { command: 'codex' } }
        }
      }
    })
    Object.defineProperty(runtime, 'createTerminal', {
      configurable: true,
      get: () => {
        events.push('read-create')
        return async function (this: OrcaRuntimeService) {
          expect(this).toBe(runtime)
          return terminal
        }
      }
    })
    await expect(
      runtime.launchAgentTerminal('workspace', {
        get agent(): 'codex' {
          events.push('read-agent')
          Object.defineProperty(runtime, 'buildStartupForAgent', { value: replacement })
          return 'codex'
        },
        prompt: 'prompt',
        get title(): string {
          events.push('read-title')
          Object.defineProperty(runtime, 'createTerminal', { value: replacement })
          return 'title'
        }
      })
    ).resolves.toBe(terminal)
    expect(events).toEqual(['read-startup', 'read-agent', 'read-create', 'read-title'])
  })

  it('captures admission store and controller before spawn argument getters', async () => {
    const runtime = new OrcaRuntimeService(null)
    const expected = new Error('captured controller refusal')
    const admission = vi.fn(async () => undefined)
    const originalStore = { admitTerminalPane: admission }
    let currentStore = originalStore
    const originalController = {
      spawn: async () => {
        throw expected
      }
    }
    let currentController = originalController
    Object.defineProperty(runtime, 'store', { get: () => currentStore })
    Object.defineProperty(runtime, 'ptyController', { get: () => currentController })
    Object.defineProperty(runtime, 'getAvailableAuthoritativeWindow', { value: () => null })
    Object.defineProperty(runtime, 'resolveTerminalWorkspaceLaunchScope', {
      value: async () => scope()
    })
    Object.defineProperty(runtime, 'resolveAgentTerminalCreateOptions', {
      value: async (_workspace: unknown, opts: unknown) => opts
    })
    Object.defineProperty(runtime, 'buildTerminalWorkspaceEnv', { value: () => ({}) })
    await expect(
      runtime.createTerminal('workspace', {
        get resumeProviderSession() {
          currentStore = {
            admitTerminalPane: vi.fn(async () => {
              throw new Error('late store')
            })
          }
          currentController = {
            spawn: async () => {
              throw new Error('late controller')
            }
          }
          return undefined
        }
      })
    ).rejects.toBe(expected)
    expect(admission).toHaveBeenCalledTimes(1)
  })

  it('rereads the canonical mobile mutation map after creation and in failure cleanup', async () => {
    const runtime = new OrcaRuntimeService(null)
    const first = new Map<string, Promise<never>>()
    const second = new Map<string, Promise<never>>()
    let current = first
    const reads: string[] = []
    Object.defineProperty(runtime, 'mobileTerminalCreateByMutationId', {
      get: () => {
        reads.push(current === first ? 'first' : 'second')
        return current
      }
    })
    const ready = Promise.withResolvers<never>()
    const expected = new Error('creation refusal')
    Object.defineProperty(runtime, 'runCreateMobileSessionTerminal', {
      value: () => {
        current = second
        return ready.promise
      }
    })
    const pending = runtime.createMobileSessionTerminal('workspace', {
      clientMutationId: 'mutation',
      select: false
    })
    expect(first.size).toBe(0)
    expect(second.size).toBe(1)
    ready.reject(expected)
    await expect(pending).rejects.toBe(expected)
    expect(second.size).toBe(0)
    expect(reads).toEqual(['first', 'second', 'second', 'second'])
  })

  it('checks graph readiness on the runtime before resolving its desktop window', async () => {
    const runtime = new OrcaRuntimeService(null)
    const expected = new Error('desktop window refusal')
    const events: string[] = []
    Object.defineProperty(runtime, 'getAvailableAuthoritativeWindow', { value: () => null })
    Object.defineProperty(runtime, 'assertGraphReady', {
      get: () => {
        events.push('read-ready')
        return function (this: OrcaRuntimeService) {
          expect(this).toBe(runtime)
          events.push('invoke-ready')
        }
      }
    })
    Object.defineProperty(runtime, 'getAuthoritativeWindow', {
      value: () => {
        events.push('read-window')
        throw expected
      }
    })
    await expect(runtime.createTerminal()).rejects.toBe(expected)
    expect(events).toEqual(['read-ready', 'invoke-ready', 'read-window'])
  })
})
