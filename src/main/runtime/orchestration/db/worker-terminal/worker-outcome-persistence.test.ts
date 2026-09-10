import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'

describe('worker outcome persistence', () => {
  it('reopens operational supersession and review retention metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-outcomes-reopen-'))
    const databasePath = join(directory, 'outcomes.db')
    let database: OrchestrationDb | undefined
    try {
      database = new OrchestrationDb(databasePath)
      const predecessor = database.createTask({ spec: 'Failed setup', purpose: 'operational' })
      const successor = database.createTask({ spec: 'Replacement', purpose: 'operational' })
      database.updateTaskStatus(predecessor.id, 'failed')
      database.recordOperationalTaskOutcome(predecessor.id, 'superseded', successor.id)
      const resource = database.createWorkerTerminalResourceStatement({
        dispatchId: 'dispatch-review',
        worktreeId: 'folder:review',
        terminalHandle: 'terminal-review',
        paneKey: 'tab-review:leaf-1',
        processIncarnation: 'pty-review:1',
        ownership: 'owned'
      })
      database.retainWorkerTerminalResourceForReview('dispatch-review', {
        owner: 'reviewer@example.com',
        reason: 'Awaiting final form approval',
        expiresAt: '2026-08-30T12:00:00.000Z',
        reviewId: 'review-1'
      })
      database.close()
      database = undefined

      database = new OrchestrationDb(databasePath)
      expect(database.getTask(predecessor.id)).toMatchObject({
        purpose: 'operational',
        operational_outcome: 'superseded',
        successor_task_id: successor.id
      })
      expect(database.getWorkerTerminalResource(resource.id)).toMatchObject({
        release_state: 'retained_for_review',
        retention_owner: 'reviewer@example.com',
        retained_reason: 'Awaiting final form approval',
        retention_expires_at: '2026-08-30T12:00:00.000Z',
        review_id: 'review-1'
      })
    } finally {
      database?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
