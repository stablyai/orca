import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'

const PTY_ID = 'pty-reattached'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const INCARNATION = 'reattach-incarnation'
const LAUNCH_CONFIG = {
  agentArgs: '--dangerously-skip-permissions --verbose',
  agentEnv: { K: 'v' }
}

const NOTE = { launchToken: 'launch-1', launchConfig: LAUNCH_CONFIG }

const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

function attach(
  runtime: OrcaRuntimeService,
  launchNote: typeof NOTE | null | undefined,
  incarnationId = INCARNATION
) {
  runtime.registerPty(PTY_ID, 'worktree-1', null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId,
    providerReattachLaunchIdentity: { incarnationId, launchAgent: 'claude' },
    reattach: launchNote === undefined ? {} : { launchNote }
  })
}

function holdLaunch(runtime: OrcaRuntimeService) {
  runtime.registerPty(PTY_ID, 'worktree-1', null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: INCARNATION,
    agentLaunchAuthority: {
      launchToken: 'launch-1',
      launchAgent: 'claude',
      launchConfig: LAUNCH_CONFIG
    }
  })
}

// Some hosts register a spawn before they report its incarnation.
async function launchedBeforeItsIncarnation(foreground: 'agent' | 'unknown') {
  const runtime = new OrcaRuntimeService(null)
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: async () => ({
      id: 'worktree-1',
      path: '/tmp/worktree-1',
      connectionId: null
    })
  })
  runtime.setPtyController({
    write: vi.fn(() => true),
    kill: vi.fn(),
    getForegroundProcess: async () => null,
    setLaunchNote: vi.fn(),
    spawn: async () => {
      runtime.registerPty(PTY_ID, 'worktree-1', null, { tabId: TAB_ID, leafId: LEAF_ID })
      return { id: PTY_ID }
    }
  })
  vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue(foreground)
  await runtime.createTerminal('id:worktree-1', {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    command: 'claude',
    launchAgent: 'claude',
    launchConfig: LAUNCH_CONFIG,
    presentation: 'background'
  })
  expect(runtime.getLaunchStatementForPaneKey(PANE_KEY, 'claude')).toEqual(LAUNCH_CONFIG)
  return runtime
}

function makeRuntime() {
  const runtime = new OrcaRuntimeService(null)
  const setLaunchNote = vi.fn()
  runtime.setPtyController({
    write: vi.fn(() => true),
    kill: vi.fn(),
    getForegroundProcess: async () => null,
    setLaunchNote
  })
  return { runtime, setLaunchNote }
}

async function reattach(
  foreground: 'agent' | 'shell' | 'unknown',
  mainHoldsLaunch = false,
  launchNote: typeof NOTE | null | 'omitted' = NOTE,
  finishedOnReattach = false
) {
  const { runtime, setLaunchNote } = makeRuntime()
  vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue(foreground)
  if (mainHoldsLaunch) {
    holdLaunch(runtime)
  }
  attach(runtime, launchNote === 'omitted' ? undefined : launchNote)
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (finishedOnReattach) {
    attach(runtime, null)
  }
  return {
    config: runtime.getLaunchStatementForPaneKey(PANE_KEY, 'claude'),
    retired: setLaunchNote.mock.calls.some(([, change]) => 'retire' in change)
  }
}

// Nothing reaches a daemon PTY while main is down, so only the same agent still running keeps the note.
describe('a daemon reattach after a main restart', () => {
  it('re-arms the unretired launch while its agent still runs', async () => {
    expect(await reattach('agent')).toEqual({ config: LAUNCH_CONFIG, retired: false })
  })

  it('says no launch runs when the foreground is the shell', async () => {
    expect(await reattach('shell')).toEqual({ config: null, retired: true })
  })

  it('says no launch runs when the daemon retired its note', async () => {
    expect((await reattach('agent', false, null)).config).toBeNull()
  })

  // Undecided: readers keep their earlier same-session rule rather than drop the settings.
  it('makes no statement when the foreground is unreadable', async () => {
    expect((await reattach('unknown')).config).toBeUndefined()
  })

  it('settles an undecided pane when a later attach reports its launch finished', async () => {
    expect((await reattach('unknown', false, NOTE, true)).config).toBeNull()
  })

  it('makes no statement for a daemon that keeps no launch notes', async () => {
    expect((await reattach('agent', false, 'omitted')).config).toBeUndefined()
  })

  it('settles an undecided pane once main sees its command finish', async () => {
    const { runtime } = makeRuntime()
    vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('unknown')
    attach(runtime, NOTE)
    await new Promise((resolve) => setTimeout(resolve, 0))
    runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })
    expect(runtime.getLaunchStatementForPaneKey(PANE_KEY, 'claude')).toBeNull()
  })

  it('does not let an earlier foreground read revive a launch a later attach saw finish', async () => {
    const { runtime } = makeRuntime()
    let answer: (foreground: 'agent') => void = () => {}
    vi.spyOn(runtime, 'readLaunchedAgentForeground').mockReturnValue(
      new Promise((resolve) => (answer = resolve))
    )
    attach(runtime, NOTE)
    attach(runtime, null)
    answer('agent')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtime.getLaunchStatementForPaneKey(PANE_KEY, 'claude')).toBeNull()
  })

  it('makes no statement for an older relay that reports no incarnation', () => {
    const { runtime } = makeRuntime()
    runtime.registerPty(PTY_ID, 'worktree-1', 'ssh-1', {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      reattach: {}
    })
    expect(runtime.getLaunchStatementForPaneKey(PANE_KEY, 'claude')).toBeUndefined()
  })

  it('starts a replacement process decided even when its spawn is announced first', () => {
    const { runtime } = makeRuntime()
    const binding = { tabId: TAB_ID, leafId: LEAF_ID }
    attach(runtime, undefined)
    runtime.onPtySpawned(PTY_ID, 'next-incarnation')
    runtime.registerPty(PTY_ID, 'worktree-1', null, {
      ...binding,
      incarnationId: 'next-incarnation'
    })
    expect(runtime.getLaunchStatementForPaneKey(PANE_KEY, 'claude')).toBeNull()
  })

  it('drops a held launch when a new process replaces it in the same terminal', () => {
    const { runtime } = makeRuntime()
    const binding = { tabId: TAB_ID, leafId: LEAF_ID }
    holdLaunch(runtime)
    runtime.onPtySpawned(PTY_ID, 'next-incarnation')
    runtime.registerPty(PTY_ID, 'worktree-1', null, {
      ...binding,
      incarnationId: 'next-incarnation'
    })
    expect(runtime.getLaunchStatementForPaneKey(PANE_KEY, 'claude')).toBeNull()
  })

  // A finished launch stays finished for its process; only a fresh launch supersedes it.
  it.each([
    ['a daemon that keeps no notes', undefined],
    ['a note the daemon has not retired', NOTE]
  ] as const)('keeps a finished launch gone when %s reattaches', async (_, launchNote) => {
    const { runtime } = makeRuntime()
    vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
    holdLaunch(runtime)
    runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })
    attach(runtime, launchNote)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtime.getLaunchStatementForPaneKey(PANE_KEY, 'claude')).toBeNull()
  })

  it('lets a replacement process prove its own launch through a reattach', async () => {
    const { runtime } = makeRuntime()
    vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
    attach(runtime, undefined)
    attach(runtime, NOTE, 'next-incarnation')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runtime.getLaunchStatementForPaneKey(PANE_KEY, 'claude')).toEqual(LAUNCH_CONFIG)
  })

  // Learning the process's first incarnation is no replacement: what main knew still holds.
  it.each([
    ['keeps no notes', undefined],
    ['still has the note', NOTE]
  ] as const)(
    'keeps a launch that finished before its first incarnation gone when a host that %s attaches',
    async (_, launchNote) => {
      const runtime = await launchedBeforeItsIncarnation('agent')
      runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: 'command-finished', exitCode: 0 })
      attach(runtime, launchNote)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(runtime.getLaunchStatementForPaneKey(PANE_KEY, 'claude')).toBeNull()
    }
  )

  it.each([
    ['keeps no notes', undefined],
    ['sends the note late', NOTE]
  ] as const)(
    'keeps a running launch when its first incarnation arrives from a host that %s',
    async (_, launchNote) => {
      const runtime = await launchedBeforeItsIncarnation('unknown')
      attach(runtime, launchNote)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(runtime.getLaunchStatementForPaneKey(PANE_KEY, 'claude')).toEqual(LAUNCH_CONFIG)
    }
  )

  // The renderer attaches a pane the CLI launched before its agent has started.
  it('leaves a launch main already holds when the attach still sees its shell', async () => {
    expect(await reattach('shell', true)).toEqual({ config: LAUNCH_CONFIG, retired: false })
  })
})
