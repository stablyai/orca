import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { CodexUsageLimits } from './codex-usage-limits'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

const RESETS_AT_S = Math.floor(Date.now() / 1000) + 3 * 24 * 3600
const CODEX_WORDS = "You've hit your usage limit. Try again in 3 days."

function translatorWithRows() {
  const bodies: AgentJournalItemBody[] = []
  const translator = createCodexJournalTranslator({
    primaryThreadId: () => 'thread',
    sink: {
      appendItem: (_identity, body) => bodies.push(body),
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  const notify = (method: string, params: Record<string, unknown>) =>
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: 'thread',
      method,
      params
    })
  return { bodies, translator, notify }
}

describe('a Codex usage limit', () => {
  it('names the spent window and its reset from the last usage report', () => {
    const { bodies, translator, notify } = translatorWithRows()
    notify('account/rateLimits/updated', {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: RESETS_AT_S - 3600 },
        secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: RESETS_AT_S }
      }
    })
    notify('account/rateLimits/updated', {
      rateLimits: {
        primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: RESETS_AT_S - 3600 }
      }
    })
    notify('error', {
      threadId: 'thread',
      turnId: 'turn',
      willRetry: false,
      error: { codexErrorInfo: 'usageLimitExceeded', message: CODEX_WORDS }
    })

    expect(bodies.filter((body) => body.kind === 'status')).toEqual([
      expect.objectContaining({
        tone: 'warning',
        text: 'Codex hit its weekly limit. Send a message once it resets to continue.',
        failure: {
          kind: 'usageLimitReached',
          usageLimit: { window: 'weekly', resetsAt: RESETS_AT_S * 1000 },
          detail: { text: CODEX_WORDS, audience: 'person' }
        }
      })
    ])
    translator.dispose()
  })
  it('merges null account updates and keeps unnamed exhausted windows in reset calculation', () => {
    const limits = new CodexUsageLimits()
    const observe = (rateLimits: Record<string, unknown>) =>
      limits.observe('notification:account/rateLimits/updated', { rateLimits })
    const failure = (code = 'usageLimitExceeded') =>
      limits.failure({
        error: { codexErrorInfo: code, message: CODEX_WORDS }
      })
    observe({
      limitId: 'codex',
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESETS_AT_S }
    })
    observe({
      limitId: null,
      primary: { usedPercent: 100, windowDurationMins: 43200, resetsAt: RESETS_AT_S + 3600 }
    })
    expect(failure()?.usageLimit).toEqual({ resetsAt: (RESETS_AT_S + 3600) * 1000 })
    observe({ secondary: { usedPercent: 100, windowDurationMins: 10080 } })
    expect(failure('rateLimitExceeded')?.usageLimit).toBeUndefined()
    observe({
      secondary: null,
      planType: 'free',
      primary: { usedPercent: 100, resetsAt: RESETS_AT_S }
    })
    expect(failure()?.usageLimit).toEqual({ resetsAt: RESETS_AT_S * 1000 })
    observe({ primary: null })
    expect(failure()?.usageLimit).toBeUndefined()
  })
})
