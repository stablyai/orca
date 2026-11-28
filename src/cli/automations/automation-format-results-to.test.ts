import { describe, expect, it } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import { EVENT_ONLY_SCHEDULE } from '../../shared/automation-event-triggers'
import { formatAutomationShow } from './automation-format'

describe('automations show for a bot automation', () => {
  it('prints where its results go', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial fixture; the formatter reads only these fields
    const automation = {
      id: 'a1',
      name: 'Redo the review',
      agentId: 'claude',
      enabled: true,
      ...EVENT_ONLY_SCHEDULE,
      once: { by: Date.UTC(2026, 10, 26, 17) },
      precheck: null,
      projectId: '',
      workspaceMode: 'existing',
      workspaceId: 'w1',
      baseBranch: null,
      reuseSession: false,
      executionTargetType: 'local',
      executionTargetId: 'local',
      prompt: 'Redo it.',
      bot: {
        botId: 'b1',
        runsIn: 'chat',
        chat: { sessionId: 's1', toConversation: true, homeIfGone: true },
        resultsTo: 'chat',
        originThread: {
          source: 'slack',
          externalId: 'T1:C1:1.2',
          place: '#ui-ux-design',
          sessionId: 's1'
        }
      }
    } as unknown as Automation
    expect(formatAutomationShow({ automation }).split('\n')).toContain(
      'results to: the Slack thread in #ui-ux-design (a reply in the thread)'
    )
  })
})
