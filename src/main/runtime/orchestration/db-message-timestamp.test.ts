import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('orchestration message timestamps', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('exposes SQLite timestamps with an explicit UTC designator', () => {
    db = new OrchestrationDb(':memory:')
    const message = db.insertMessage({ from: 'a', to: 'b', subject: 'timestamped' })

    expect(message.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/)
    db.markAsDelivered([message.id])
    expect(db.getMessageById(message.id)?.delivered_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
    )
  })
})
