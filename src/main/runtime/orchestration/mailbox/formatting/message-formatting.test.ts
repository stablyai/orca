import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { formatMessageBanner } from './message-formatting'

describe('formatMessageBanner', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => db?.close())

  it('offers no reply on a notice and a reply on other current mail', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'banner',
      coordinatorHandle: 'term_a',
      coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
    })
    const mail = (type: 'notice' | 'status') =>
      formatMessageBanner(
        db!.insertMessage({ runId: run.id, from: 'term_a', to: 'term_b', subject: 'FYI', type })
      )

    const notice = mail('notice')
    expect(notice).toContain('(notice)')
    expect(notice).toContain('[For your information: no reply needed.]')
    expect(notice).not.toContain('[Reply:')
    expect(mail('status')).toContain('orchestration reply --id')
  })
})
