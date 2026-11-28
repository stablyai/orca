import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

describe("a pair's quota window", () => {
  let db: OrchestrationDb
  afterEach(() => db.close())

  const refused = new Error('over the quota')
  const pairLimit = {
    requests: 3,
    minutes: 10,
    refuse: (): never => {
      throw refused
    }
  }
  let sends = 0
  const admit = () =>
    db.admitBotRequest({
      rootKey: 'root',
      sendKey: `send-${(sends += 1)}`,
      fromBotId: 'ranger',
      toBotId: 'docs',
      purpose: 'question',
      depth: 1,
      record: '{}',
      message: { from: 'orca_session_id:a', to: 'orca_session_id:docs', subject: `q${sends}` },
      pairLimit
    })
  /** An earlier request stored at `at`, a SQLite time expression. */
  const storedAt = (at: string) => {
    const sent = admit()
    const id = sent.kind === 'sent' ? sent.message.id : ''
    db.db.prepare(`UPDATE bot_requests SET created_at = ${at} WHERE message_id = ?`).run(id)
  }

  it('admits up to the quota and refuses the next', () => {
    db = new OrchestrationDb(':memory:')
    storedAt("strftime('%Y-%m-%d %H:%M:%f', 'now', '-1 minutes')")
    storedAt("strftime('%Y-%m-%d %H:%M:%f', 'now', '-2 minutes')")
    expect(admit().kind).toBe('sent')
    expect(() => admit()).toThrow(refused)
  })

  it('drops requests from before the window and counts those in it', () => {
    db = new OrchestrationDb(':memory:')
    storedAt("strftime('%Y-%m-%d %H:%M:%f', 'now', '-601 seconds')")
    storedAt("strftime('%Y-%m-%d %H:%M:%f', 'now', '-599 seconds')")
    expect(db.botRequestsSentWithin({ fromBotId: 'ranger', toBotId: 'docs' }, 10).count).toBe(1)
    expect(admit().kind).toBe('sent')
    expect(admit().kind).toBe('sent')
    expect(() => admit()).toThrow(refused)
  })
})
