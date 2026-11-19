import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import { captureAutomationRunMessage } from './automation-run-message-capture'
import { automationRunPrompt } from './automation-event-prompt'

const PROMPT = 'Answer review questions on my PRs.'

const automation: Parameters<typeof captureAutomationRunMessage>[0] = {
  id: 'auto-1',
  name: 'Answer review questions',
  prompt: PROMPT,
  enabled: true,
  nextRunAt: 0,
  updatedAt: 1,
  dtstart: 0,
  rrule: 'FREQ=DAILY',
  workspaceId: 'folder:bot',
  once: {}
}

const event: AutomationRunEvent = {
  triggerId: 't1',
  source: 'github',
  event: 'comment',
  key: 'k1',
  occurredAt: 1_800_000_000_000,
  actor: 'Nora',
  place: 'stablyai/orca#41812',
  url: 'https://github.com/stablyai/orca/pull/41812',
  text: 'x'.repeat(5000)
}

type CapturedRun = Parameters<typeof captureAutomationRunMessage>[1]

function run(fields: Partial<Pick<AutomationRun, 'trigger' | 'event'>>): CapturedRun {
  return { id: 'run-1', scheduledFor: 1_800_000_000_000, trigger: 'event', ...fields }
}

describe('captureAutomationRunMessage', () => {
  it('records the event as it was quoted, the asker at delivery, and how the wait ended', () => {
    const eventRun = run({ event })
    const text = automationRunPrompt(PROMPT, event, 'member')

    expect(captureAutomationRunMessage(automation, eventRun, text, 'member')).toEqual({
      runId: 'run-1',
      automation: expect.objectContaining({ id: 'auto-1', name: 'Answer review questions' }),
      trigger: 'event',
      wait: { kind: 'event', at: 1_800_000_000_000, actor: 'Nora' },
      event: {
        source: 'github',
        event: 'comment',
        occurredAt: 1_800_000_000_000,
        place: 'stablyai/orca#41812',
        url: 'https://github.com/stablyai/orca/pull/41812',
        actor: 'Nora',
        text: 'x'.repeat(4096),
        textShortened: true,
        asker: 'member'
      },
      instructionsLength: PROMPT.length
    })
  })

  it('marks Run now as a replay of the event and ends no wait', () => {
    const captured = captureAutomationRunMessage(
      automation,
      run({ trigger: 'manual', event }),
      automationRunPrompt(PROMPT, event),
      null
    )

    expect(captured?.event?.replayed).toBe(true)
    expect(captured?.wait).toBeUndefined()
  })

  it('records nothing when the sent text does not start with the saved prompt', () => {
    expect(
      captureAutomationRunMessage(automation, run({ event }), 'Something else', null)
    ).toBeUndefined()
  })
})
