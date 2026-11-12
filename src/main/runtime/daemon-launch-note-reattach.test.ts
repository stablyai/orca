import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a daemon reattach after a main restart', () => {
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

  it('re-arms an unretired local Windows launch note when confirmForegroundProcess confirms the agent', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const runtime = new OrcaRuntimeService(null)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(),
      getForegroundProcess: async () => 'agy',
      confirmForegroundProcess: async () => 'agy',
      confirmShellForeground: async () => false,
      setLaunchNote: vi.fn()
    })
    runtime.registerPty(PTY_ID, 'worktree-1', null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION,
      providerReattachLaunchIdentity: { incarnationId: INCARNATION, launchAgent: 'antigravity' },
      reattach: { launchNote: NOTE }
    })

    await vi.waitFor(() => {
      expect(runtime.getLaunchStatementForPaneKey(PANE_KEY, 'antigravity')).toEqual(LAUNCH_CONFIG)
    })
  })
})
