import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'

const PTY = 'synthetic-pty'
const WORKSPACE = 'folder:synthetic'
const binding = { tabId: 'tab-terminal', leafId: '11111111-1111-4111-8111-111111111111' }

function fixture() {
  const runtime = new OrcaRuntimeService(null)
  const pending: ((value: PtyProcessInfo[]) => void)[] = []
  const controller = {
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(() => new Promise<PtyProcessInfo[]>((resolve) => pending.push(resolve)))
  }
  runtime.setPtyController(controller)
  const internal = runtime as unknown as {
    ptysById: Map<string, RuntimePtyWorktreeRecord>
    handleByPtyId: Map<string, string>
    refreshPtyWorktreeRecordsWithControllerInventory: (
      worktrees: [],
      target?: null,
      deadline?: undefined,
      connectionId?: string | null
    ) => Promise<PtyControllerInventory | null>
    recordPtyWorktree: (id: string, workspace: string, state?: object) => void
    dropDisconnectedPtyRecord: (id: string) => void
    clearPtyIncarnationHandles: () => void
    invalidateAllHandlesForPty: (id: string) => void
    retirePtyAgentLaunchAuthority: (id: string) => void
    rollbackLegacyWorkerTerminalSurface: (candidate: object) => void
  }
  function register(incarnationId: string, id = PTY, workspace = WORKSPACE) {
    runtime.registerPty(id, workspace, null, {
      ...binding,
      incarnationId,
      agentLaunchAuthority: { launchToken: `synthetic-${incarnationId}`, launchAgent: 'codex' }
    })
  }
  function session(incarnationId: string, id = PTY): PtyProcessInfo {
    return { id, worktreeId: WORKSPACE, incarnationId, cwd: '', title: `title-${incarnationId}` }
  }
  return {
    runtime,
    internal,
    controller,
    register,
    session,
    record: () => internal.ptysById.get(PTY)!,
    start: (connectionId?: string | null) =>
      internal.refreshPtyWorktreeRecordsWithControllerInventory([], null, undefined, connectionId),
    finish: (sessions: PtyProcessInfo[], index = 0) => pending[index](sessions)
  }
}

describe('inventory ownership revision admission', () => {
  it.each(['old', 'unknown', 'absent'])(
    'rejects delayed %s observation after replacement registration',
    async (reply) => {
      const f = fixture()
      f.register('a')
      const pending = f.start()
      f.register('b')
      f.runtime.registerPreAllocatedHandleForPty(PTY, 'term_replacement')
      const before = { ...f.record() }
      f.finish(
        reply === 'absent'
          ? []
          : [
              {
                ...f.session('a'),
                incarnationId: reply === 'unknown' ? undefined : 'a',
                terminalHandle: 'term_predecessor'
              }
            ]
      )
      expect(await pending).toBeNull()
      expect(f.record()).toEqual(before)
      expect(f.internal.handleByPtyId.get(PTY)).toBe('term_replacement')
    }
  )

  it('accepts positive current-B evidence without discarding B metadata', async () => {
    const f = fixture()
    f.register('a')
    const pending = f.start()
    f.register('b')
    f.record().launchConfig = { agentCommand: 'codex', agentArgs: 'synthetic', agentEnv: {} }
    f.finish([f.session('b')])
    expect(await pending).not.toBeNull()
    expect(f.record()).toMatchObject({
      incarnationId: 'b',
      launchToken: 'synthetic-b',
      launchAgent: 'codex',
      controllerTitle: 'title-b',
      launchConfig: { agentArgs: 'synthetic' }
    })
  })

  it('admits a genuine replacement observed by a request begun after B registered', async () => {
    const f = fixture()
    f.register('b')
    const pending = f.start()
    f.finish([f.session('c')])
    expect(await pending).not.toBeNull()
    expect(f.record()).toMatchObject({
      incarnationId: 'c',
      launchToken: null,
      launchAgent: null,
      controllerTitle: 'title-c'
    })
  })

  it.each(['old', 'absent'])(
    'does not lose a newly registered owner to %s inventory',
    async (reply) => {
      const f = fixture()
      const pending = f.start()
      f.register('b')
      f.finish(reply === 'absent' ? [] : [f.session('a')])
      expect(await pending).toBeNull()
      expect(f.record()).toMatchObject({
        incarnationId: 'b',
        launchToken: 'synthetic-b',
        connected: true
      })
    }
  )

  it.each([
    'spawn',
    'pending-registration',
    'exit-identity',
    'exit',
    'drop',
    'clear',
    'invalidate',
    'retire',
    'rebind',
    'controller'
  ])('fences an inventory crossing %s before any metadata mutation', async (writer) => {
    const f = fixture()
    f.register('a')
    const pending = f.start()
    if (writer === 'spawn') {
      f.runtime.onPtySpawned(PTY, 'b')
    }
    if (writer === 'pending-registration') {
      f.runtime.beginPtyRegistration(PTY, 'b')
    }
    if (writer === 'exit-identity') {
      f.runtime.acceptPtyIncarnationForExit(PTY, 'b')
    }
    if (writer === 'exit') {
      f.runtime.onPtyExit(PTY, 0, 'a')
    }
    if (writer === 'drop') {
      f.internal.dropDisconnectedPtyRecord(PTY)
    }
    if (writer === 'clear') {
      f.internal.clearPtyIncarnationHandles()
    }
    if (writer === 'invalidate') {
      f.internal.invalidateAllHandlesForPty(PTY)
    }
    if (writer === 'retire') {
      f.internal.retirePtyAgentLaunchAuthority(PTY)
    }
    if (writer === 'rebind') {
      f.internal.recordPtyWorktree(PTY, 'folder:new')
    }
    if (writer === 'controller') {
      f.runtime.setPtyController(f.controller)
    }
    const before = f.record() ? { ...f.record() } : undefined
    f.finish([f.session('a')])
    expect(await pending).toBeNull()
    expect(f.record()).toEqual(before)
  })

  it.each(['clear', 'exit', 'rebind'])('positive equality cannot override %s', async (writer) => {
    const f = fixture()
    f.register('b')
    const pending = f.start()
    if (writer === 'clear') {
      f.internal.clearPtyIncarnationHandles()
    }
    if (writer === 'exit') {
      f.runtime.onPtyExit(PTY, 0, 'b')
    }
    if (writer === 'rebind') {
      f.internal.recordPtyWorktree(PTY, 'folder:new')
    }
    const before = { ...f.record() }
    f.finish([f.session('b')])
    expect(await pending).toBeNull()
    expect(f.record()).toEqual(before)
  })

  it('does not resurrect an ID created then removed during inventory', async () => {
    const f = fixture()
    const pending = f.start()
    f.register('b')
    f.internal.dropDisconnectedPtyRecord(PTY)
    f.finish([f.session('b')])
    expect(await pending).toBeNull()
    expect(f.record()).toBeUndefined()
  })

  it('preserves inventory ordering across parallel requests and owner changes', async () => {
    const f = fixture()
    f.register('a')
    const first = f.start()
    f.register('b')
    const second = f.start()
    f.finish([f.session('b')], 1)
    expect(await second).not.toBeNull()
    f.finish([f.session('a')])
    expect(await first).toBeNull()
    expect(f.record()).toMatchObject({ incarnationId: 'b', launchToken: 'synthetic-b' })
  })

  it('ignores unrelated SSH ownership changes during a local census', async () => {
    const f = fixture()
    f.register('a')
    const pending = f.start(null)
    f.runtime.registerPty('ssh:other@@pty', 'folder:remote', 'other', {
      ...binding,
      incarnationId: 'remote-b'
    })
    f.finish([f.session('a')])
    expect(await pending).not.toBeNull()
    expect(f.record().controllerTitle).toBe('title-a')
  })

  it('does not let a local observation revert a new SSH binding', async () => {
    const f = fixture()
    f.register('a')
    const pending = f.start(null)
    f.runtime.registerPty(PTY, 'folder:remote', 'other', { ...binding, incarnationId: 'b' })
    f.finish([f.session('a')])
    expect(await pending).toBeNull()
    expect(f.record()).toMatchObject({
      incarnationId: 'b',
      connectionId: 'other',
      worktreeId: 'folder:remote'
    })
  })

  it('rejects a matching incarnation with a predecessor binding or exported handle', async () => {
    const f = fixture()
    f.register('a')
    const pending = f.start()
    f.register('b', PTY, 'folder:new')
    f.finish([{ ...f.session('b'), terminalHandle: 'term_predecessor' }])
    expect(await pending).toBeNull()
    expect(f.record()).toMatchObject({
      incarnationId: 'b',
      launchToken: 'synthetic-b',
      worktreeId: 'folder:new'
    })
  })

  it('releases rejected inventory observations before a later valid census', async () => {
    const f = fixture()
    f.register('a')
    const first = f.start()
    f.internal.clearPtyIncarnationHandles()
    f.finish([f.session('a')])
    expect(await first).toBeNull()
    const second = f.start()
    f.finish([f.session('a')], 1)
    expect(await second).not.toBeNull()
    expect(f.record().launchToken).toBe('synthetic-a')
  })

  it('fences observations crossing cancellation of a pending registration', async () => {
    const f = fixture()
    f.register('a')
    f.runtime.beginPtyRegistration(PTY, 'b')
    const pending = f.start()
    f.runtime.cancelPendingPtyRegistration(PTY, 'b')
    f.finish([])
    expect(await pending).toBeNull()
    expect(f.record().connected).toBe(true)
  })

  it.each(['present', 'absent'])('fences %s inventory across recovery rollback', async (reply) => {
    const f = fixture()
    f.register('a')
    const pending = f.start()
    f.internal.rollbackLegacyWorkerTerminalSurface({
      ptyId: PTY,
      worktreeId: WORKSPACE,
      tabId: binding.tabId,
      leafId: binding.leafId,
      paneKey: f.record().paneKey
    })
    const before = { ...f.record() }
    f.finish(reply === 'present' ? [f.session('a')] : [])
    expect(await pending).toBeNull()
    expect(f.record()).toEqual(before)
    expect(f.record().paneKey).toBeNull()
  })

  it('reconciles absence from a current inventory', async () => {
    const f = fixture()
    f.register('b')
    const pending = f.start()
    f.finish([])
    expect(await pending).not.toBeNull()
    expect(f.record().connected).toBe(false)
  })

  it('preserves metadata on unchanged and renewed same-incarnation ownership', async () => {
    const f = fixture()
    f.register('a')
    const pending = f.start()
    f.register('a')
    f.finish([f.session('a')])
    expect(await pending).not.toBeNull()
    expect(f.record()).toMatchObject({
      launchToken: 'synthetic-a',
      launchAgent: 'codex',
      controllerTitle: 'title-a'
    })
  })
})
