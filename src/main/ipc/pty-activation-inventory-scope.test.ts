import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerSshPtyProvider, getLocalPtyProvider } from './pty'
import { installPtyInspectIpcHandlers } from './pty/ipc/inspect'
import { ptyOwnership } from './pty/provider/ownership-state'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('scoped activation PTY inventory', () => {
  const { handlers, installDaemonTestProvider } = setupPtyIpcSuite()

  function install() {
    const localList = vi.fn(async () => [{ id: 'local', cwd: '/', title: 'shell' }])
    installDaemonTestProvider({ listProcesses: localList })
    const remoteLists = Array.from({ length: 50 }, (_, index) => {
      const list = vi.fn(async () => [
        {
          id: `ssh:host-${index}@@pty-1`,
          cwd: '/remote',
          title: 'agent',
          worktreeId: 'repo::/remote'
        }
      ])
      registerSshPtyProvider(`host-${index}`, {
        ...getLocalPtyProvider(),
        listProcesses: list,
        providesAgentSessionOwnerListings: () => true
      })
      return list
    })
    const startup = vi.fn(async () => {})
    installPtyInspectIpcHandlers({ getLocalPtyProviderStartupPromise: startup })
    // Why .sessions: these cases assert the rows; completeness has its own case.
    const list = async (scope?: unknown) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler resolves PtySessionListing; the handler map erases it.
      ((await handlers.get('pty:listSessions')!(null, scope)) as { sessions: unknown[] }).sessions
    return { localList, remoteLists, startup, list }
  }

  it('queries only the chosen SSH provider and preserves workspace and ownership evidence', async () => {
    const { list, localList, remoteLists, startup } = install()
    expect(await list({ connectionId: 'host-17' })).toEqual([
      {
        id: 'ssh:host-17@@pty-1',
        cwd: '/remote',
        title: 'agent',
        worktreeId: 'repo::/remote',
        agentOwnership: 'absent'
      }
    ])
    expect(remoteLists[17]).toHaveBeenCalledOnce()
    expect(remoteLists.reduce((count, mock) => count + mock.mock.calls.length, 0)).toBe(1)
    expect(localList).not.toHaveBeenCalled()
    expect(startup).not.toHaveBeenCalled()
    expect(ptyOwnership.get('ssh:host-17@@pty-1')).toBe('host-17')
  })

  it('waits for local startup and never visits remote providers for a local scope', async () => {
    const { list, localList, remoteLists, startup } = install()
    let release!: () => void
    startup.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const pending = list({ connectionId: null })
    expect(localList).not.toHaveBeenCalled()
    release()
    await pending
    expect(localList).toHaveBeenCalledOnce()
    expect(remoteLists.every((mock) => mock.mock.calls.length === 0)).toBe(true)
  })

  it('propagates selected-host failure and never substitutes the local inventory', async () => {
    const { list, localList, remoteLists } = install()
    remoteLists[3].mockRejectedValue(new Error('relay unavailable'))
    await expect(list({ connectionId: 'host-3' })).rejects.toThrow('relay unavailable')
    await expect(list({ connectionId: 'missing' })).rejects.toThrow('No PTY provider')
    expect(localList).not.toHaveBeenCalled()
  })

  it.each([null, {}, { connectionId: '' }, { connectionId: 42 }])(
    'rejects malformed scope %j before inventory admission',
    async (scope) => {
      const { list, localList, remoteLists } = install()
      await expect(list(scope)).rejects.toThrow('invalid_pty_session_list_scope')
      expect(localList).not.toHaveBeenCalled()
      expect(remoteLists.every((mock) => mock.mock.calls.length === 0)).toBe(true)
    }
  )

  it('preserves unscoped diagnostic inventory and its remote-error fallback', async () => {
    const { list, localList, remoteLists } = install()
    remoteLists[3].mockRejectedValue(new Error('relay unavailable'))
    expect(await list()).toHaveLength(50)
    expect(localList).toHaveBeenCalledOnce()
    expect(remoteLists.every((mock) => mock.mock.calls.length === 1)).toBe(true)
  })

  it('lists the versions that answered and marks the inventory incomplete while one is silent', async () => {
    let listBySource: ReturnType<typeof vi.fn> | undefined
    installDaemonTestProvider({
      listProcesses: vi.fn(async () => {
        throw new Error('Request listSessions timed out')
      }),
      listProcessesBySource: (listBySource = vi.fn(async () => [
        {
          protocolVersion: 36,
          isCurrent: true,
          contact: 'live' as const,
          processes: [{ id: 'wt@@current', cwd: '/', title: 'shell' }]
        },
        {
          protocolVersion: 35,
          isCurrent: false,
          contact: 'unverifiable' as const,
          error: new Error('Request listSessions timed out'),
          lastKnownIds: ['wt@@old']
        }
      ]))
    })
    installPtyInspectIpcHandlers({ getLocalPtyProviderStartupPromise: async () => {} })

    for (const scope of [undefined, { connectionId: null }]) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler resolves PtySessionListing; the handler map erases it.
      const listing = (await handlers.get('pty:listSessions')!(null, scope)) as {
        sessions: { id: string }[]
        complete: boolean
        unverifiable: { protocolVersion: number | null }[]
      }
      // Why the filter: SSH providers registered by earlier cases stay in the unscoped listing.
      const local = listing.sessions.filter((session) => !session.id.startsWith('ssh:'))
      expect(local.map((session) => session.id)).toEqual(['wt@@current'])
      expect(listing.complete).toBe(false)
      expect(listing.unverifiable).toEqual([
        { protocolVersion: 35, reason: 'Request listSessions timed out' }
      ])
    }
    // The cap bounds only other versions; the current one keeps the caller's (unbounded) wait.
    expect(listBySource).toHaveBeenCalledWith({ nonCurrentDeadlineMs: expect.any(Number) })
  })

  it('fails as before when the current version itself does not answer', async () => {
    installDaemonTestProvider({
      listProcessesBySource: vi.fn(async () => [
        {
          protocolVersion: 36,
          isCurrent: true,
          contact: 'unverifiable' as const,
          error: new Error('daemon not responding'),
          lastKnownIds: []
        }
      ])
    })
    installPtyInspectIpcHandlers({ getLocalPtyProviderStartupPromise: async () => {} })

    // Resource Manager keeps its "not responding" state; the activation gate blocks as before.
    for (const scope of [undefined, { connectionId: null }]) {
      await expect(handlers.get('pty:listSessions')!(null, scope)).rejects.toThrow(
        'daemon not responding'
      )
    }
  })

  it('judges a scoped listing complete for a worktree the silent version holds no evidence of', async () => {
    installDaemonTestProvider({
      listProcessesBySource: vi.fn(async () => [
        { protocolVersion: 36, isCurrent: true, contact: 'live' as const, processes: [] },
        {
          protocolVersion: 35,
          isCurrent: false,
          contact: 'unverifiable' as const,
          error: new Error('Request listSessions timed out'),
          lastKnownIds: ['repo::/old@@a1']
        }
      ])
    })
    const savedSession = {
      tabsByWorktree: {
        'repo::/restored': [{ id: 't1', worktreeId: 'repo::/restored', ptyId: null }]
      },
      terminalLayoutsByTabId: { t1: { ptyIdsByLeafId: { l1: 'repo::/restored@@saved' } } }
    }
    installPtyInspectIpcHandlers({
      getLocalPtyProviderStartupPromise: async () => {},
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the evidence reader uses only tabs and layout bindings.
      getWorkspaceSession: () => savedSession as never
    })
    const list = async (worktreeId: string): Promise<unknown> =>
      await handlers.get('pty:listSessions')!(null, { connectionId: null, worktreeId })

    // A newly added worktree: nothing points at the silent version, so activation is not blocked.
    await expect(list('repo::/new')).resolves.toMatchObject({ complete: true })
    // The silent version was last known to hold this worktree's session.
    await expect(list('repo::/old')).resolves.toMatchObject({ complete: false })
    // A saved tab is bound to a session no answering version listed.
    await expect(list('repo::/restored')).resolves.toMatchObject({ complete: false })
  })
})
