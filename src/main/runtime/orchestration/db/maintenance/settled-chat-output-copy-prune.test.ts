import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { pruneSettledChatOutputCopies } from './settled-chat-output-copy-prune'

const CHAT_COPY = JSON.stringify({
  version: 1,
  agent: 'claude',
  processIncarnation: 'pi_1',
  messages: [{ id: 'm1', role: 'assistant', blocks: [{ type: 'text', text: 'x'.repeat(8_000) }] }],
  limited: false,
  warnings: []
})

describe('pruning settled chat output copies', () => {
  let db: OrchestrationDb

  afterEach(() => db.close())

  function worker(
    id: string,
    run: string,
    options: { kind?: string; status?: string; completedDaysAgo?: number } = {}
  ): void {
    const { kind = 'structured_journal', status = 'completed', completedDaysAgo = 3 } = options
    const at = `-${completedDaysAgo * 24} hours`
    db.db.prepare('INSERT OR IGNORE INTO runs (id, objective) VALUES (?, ?)').run(run, 'objective')
    db.db
      .prepare(
        `INSERT INTO dispatch_contexts (id, run_id, task_id, status, completed_at)
         VALUES (?, ?, 'task', ?, CASE WHEN ? IN ('pending', 'dispatched') THEN NULL ELSE datetime('now', ?) END)`
      )
      .run(id, run, status, status, at)
    db.db
      .prepare(
        `INSERT INTO worker_terminal_resources (id, origin_dispatch_id, owner_dispatch_id, terminal_handle,
           ownership_state, release_state, release_completed_at)
         VALUES (?, ?, ?, ?, 'released', 'released', datetime('now', ?))`
      )
      .run(`res_${id}`, id, id, `term_${id}`, at)
    db.db
      .prepare(
        'INSERT INTO worker_terminal_archives (dispatch_id, resource_id, kind, content) VALUES (?, ?, ?, ?)'
      )
      .run(id, `res_${id}`, kind, CHAT_COPY)
  }

  function content(id: string): string {
    return String(
      db.db.prepare('SELECT content FROM worker_terminal_archives WHERE dispatch_id = ?').get(id)
        ?.content
    )
  }

  it('points copies of Runs settled over a day ago at their readable chat and keeps the rest', () => {
    db = new OrchestrationDb(':memory:')
    worker('settled', 'run_settled')
    worker('terminal', 'run_settled', { kind: 'transcript_pin' })
    worker('recent', 'run_recent', { completedDaysAgo: 0.1 })
    worker('live_done', 'run_live')
    worker('live_working', 'run_live', { status: 'dispatched' })
    worker('unreadable', 'run_settled')

    expect(
      pruneSettledChatOutputCopies(db, '', (dispatchId) => dispatchId !== 'unreadable')
    ).toEqual({ pruned: 1, next: null })

    expect(content('settled')).toMatch(
      /^\{"version":3,"agent":"claude","processIncarnation":"pi_1","messages":\[\],"limited":true,/
    )
    for (const kept of ['terminal', 'recent', 'live_done', 'live_working', 'unreadable']) {
      expect(content(kept)).toBe(CHAT_COPY)
    }
  })
})
