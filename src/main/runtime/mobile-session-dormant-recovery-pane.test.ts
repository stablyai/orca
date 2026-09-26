import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import { isDormantRecoveryPane } from './mobile-session-dormant-recovery-pane'

const LEAF = '3c2b1a00-0000-4000-8000-000000000001'

function sessionWith(origin: SleepingAgentSessionRecord['origin']) {
  return {
    sleepingAgentSessionsByPaneKey: {
      [`tab-1:${LEAF}`]: {
        paneKey: `tab-1:${LEAF}`,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'session-1' },
        prompt: '',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        launchConfig: { agentArgs: '', agentEnv: {} },
        origin,
        restoreOnTabOpenOnly: false
      } satisfies SleepingAgentSessionRecord
    }
  }
}

describe('isDormantRecoveryPane', () => {
  it.each([
    ['a dormant recovered session', 'recovery', true],
    ['a slept workspace pane, which a tap wakes', 'worktree-sleep', false]
  ] as const)('holds %s: %s', (_label, origin, held) => {
    expect(isDormantRecoveryPane(sessionWith(origin), { parentTabId: 'tab-1', leafId: LEAF })).toBe(
      held
    )
  })

  it('holds nothing for a pane without a record', () => {
    expect(
      isDormantRecoveryPane(sessionWith('recovery'), { parentTabId: 'tab-2', leafId: LEAF })
    ).toBe(false)
  })
})
