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

async function reattach(
  foreground: 'agent' | 'shell' | 'unknown',
  mainHoldsLaunch = false,
  launchNote: typeof NOTE | null | 'omitted' = NOTE,
  finishedOnReattach = false
) {
  const runtime = new OrcaRuntimeService(null)
  const setLaunchNote = vi.fn()
  runtime.setPtyController({
    write: vi.fn(() => true),
    kill: vi.fn(),
    getForegroundProcess: async () => null,
    setLaunchNote
  })
  vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue(foreground)
  const binding = { tabId: TAB_ID, leafId: LEAF_ID, incarnationId: INCARNATION }
  if (mainHoldsLaunch) {
    runtime.registerPty(PTY_ID, 'worktree-1', null, {
      ...binding,
      agentLaunchAuthority: {
        launchToken: 'launch-1',
        launchAgent: 'claude',
        launchConfig: LAUNCH_CONFIG
      }
    })
  }
  runtime.registerPty(PTY_ID, 'worktree-1', null, {
    ...binding,
    providerReattachLaunchIdentity: {
      incarnationId: INCARNATION,
      launchAgent: 'claude',
      ...(launchNote !== 'omitted' ? { launchNote } : {})
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (finishedOnReattach) {
    runtime.registerPty(PTY_ID, 'worktree-1', null, {
      ...binding,
      providerReattachLaunchIdentity: {
        incarnationId: INCARNATION,
        launchAgent: 'claude',
        launchNote: null
      }
    })
  }
  return {
    config: runtime.getLaunchStatementForPaneKey(makePaneKey(TAB_ID, LEAF_ID), 'claude'),
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

  // The renderer attaches a pane the CLI launched before its agent has started.
  it('leaves a launch main already holds when the attach still sees its shell', async () => {
    expect(await reattach('shell', true)).toEqual({ config: LAUNCH_CONFIG, retired: false })
  })
})
