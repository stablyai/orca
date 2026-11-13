import { describe, expect, it } from 'vitest'
import {
  FORWARDED_TOOL,
  harness,
  ORPHAN_FAILED_NOTIFICATION,
  START_BASH
} from './claude-background-task-row-test-support'

describe('claude background task terminal frames', () => {
  it('does not resurrect an orphan outcome that named its own parent tool', () => {
    const { rows, items, latest } = harness([
      FORWARDED_TOOL,
      ORPHAN_FAILED_NOTIFICATION.tool_use_id
    ])
    rows.observe(ORPHAN_FAILED_NOTIFICATION)
    rows.observe({
      ...START_BASH,
      task_id: ORPHAN_FAILED_NOTIFICATION.task_id,
      tool_use_id: ORPHAN_FAILED_NOTIFICATION.tool_use_id
    })
    expect(items).toHaveLength(1)
    expect(latest()).toMatchObject({ state: 'blocked' })
  })
})
