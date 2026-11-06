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

async function reattach(foreground: 'agent' | 'shell' | 'unknown') {
  const runtime = new OrcaRuntimeService(null)
  runtime.setPtyController({
    write: vi.fn(() => true),
    kill: vi.fn(),
    getForegroundProcess: async () => null,
    setLaunchNote: vi.fn()
  })
  const read = vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue(foreground)
  runtime.registerPty(PTY_ID, 'worktree-1', null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: INCARNATION,
    providerReattachLaunchIdentity: {
      incarnationId: INCARNATION,
      launchAgent: 'claude',
      launchNote: { launchToken: 'launch-1', launchConfig: LAUNCH_CONFIG }
    }
  })
  await vi.waitFor(() => expect(read).toHaveBeenCalled())
  await Promise.resolve()
  return runtime.getAttestedLaunchConfigForPaneKey(makePaneKey(TAB_ID, LEAF_ID), 'claude')
}

// Nothing reaches a daemon PTY while main is down, so only the same agent still running keeps the note.
describe('a daemon reattach after a main restart', () => {
  it('re-arms the unretired launch while its agent still runs', async () => {
    expect(await reattach('agent')).toEqual(LAUNCH_CONFIG)
  })

  it.each(['shell', 'unknown'] as const)('declines when the foreground is %s', async (fg) => {
    expect(await reattach(fg)).toBeUndefined()
  })
})
