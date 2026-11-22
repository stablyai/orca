import { describe, expect, it } from 'vitest'
import { runsPageSchema } from './automation-reply-schema'

const run = {
  id: 'run-1',
  automationId: 'automation-1',
  title: 'Answer the webhook',
  status: 'completed',
  trigger: 'event',
  scheduledFor: 1700000000000,
  createdAt: 1700000000000,
  startedAt: 1700000000001,
  dispatchedAt: 1700000000002,
  workspaceId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  error: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null
}

describe('a runs page', () => {
  it("keeps a run whose event this build can't read, without its event", () => {
    const page = runsPageSchema.parse({ runs: [{ ...run, event: { source: 42 } }] })
    expect(page.unreadableRuns).toBe(0)
    expect(page.runs[0]?.event).toBeUndefined()
  })

  it("keeps a run whose starting source this build can't read, with its event", () => {
    const page = runsPageSchema.parse({
      runs: [{ ...run, triggeredBy: { source: 7 }, event: { source: 'slack' } }]
    })
    expect(page.unreadableRuns).toBe(0)
    expect(page.runs[0]?.triggeredBy).toBeUndefined()
    expect(page.runs[0]?.event).toEqual({ source: 'slack' })
  })
})
