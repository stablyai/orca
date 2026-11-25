import { afterEach, describe, expect, it } from 'vitest'
import { createOrchestrationRpcHarness } from '../../rpc-test-harness'
import { earlierWork } from './worker-earlier-work'

// A fresh follow-up agent (started fresh, or a reopen that found no saved conversation) cannot see
// the completion receipt its coordinator was pointed to; the earlier-work section carries it.
describe('earlier work for a fresh follow-up agent', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

  const latestWith = (result: Record<string, unknown> | null) => {
    const { db } = harness.setup()
    const task = db.createTask({ spec: 'Make the change' })
    if (result) {
      db.db.prepare('UPDATE tasks SET result = ? WHERE id = ?').run(JSON.stringify(result), task.id)
    }
    return { db, latest: { task_id: task.id } }
  }
  const report = { outcome: 'succeeded', subject: 'Opened org/q#17', body: 'Tests pass' }

  it('restates each outside pull request and points to the adopt command of this terminal', () => {
    const { db, latest } = latestWith({
      ...report,
      workspaceCheck: {
        version: 1,
        state: 'complete',
        outside: [
          { forgeHost: 'github.com', owner: 'org', repo: 'q', number: 17 },
          { forgeHost: 'git.example', owner: 'org', repo: 'e', number: 3 }
        ]
      }
    })
    const text = earlierWork(db, latest)
    expect(text.split('\n')).toEqual([
      'Earlier work on this worker (its conversation could not be reopened):',
      'Earlier task: Make the change',
      'Its report (succeeded): Opened org/q#17 — Tests pass',
      'Its completion receipt: At report time, Orca found no workspace for org/q under your workspace (cited: #17). If you opened it, adopt it with the worktree adopt command under YOUR WORKSPACE above.',
      'Its completion receipt: At report time, Orca found no workspace for git.example/org/e under your workspace (cited: #3). If you opened it, adopt it with the worktree adopt command under YOUR WORKSPACE above.'
    ])
    // No launcher or quoted selector of the earlier terminal: this agent's own preamble renders
    // the command for the terminal it runs in, whatever launcher and shell that is.
    expect(text).not.toMatch(/\borca(-ide|-dev)?\b|--parent-worktree/)
  })

  it.each([
    ['no check', report],
    [
      'a skipped check',
      { ...report, workspaceCheck: { version: 1, state: 'skipped', outside: [] } }
    ],
    [
      'a partial check',
      { ...report, workspaceCheck: { version: 1, state: 'partial', outside: [] } }
    ],
    [
      'an unreadable check',
      { ...report, workspaceCheck: { version: 2, outside: [{ owner: 'org', repo: 'q' }] } }
    ]
  ])('adds nothing for %s', (_name, result) => {
    const { db, latest } = latestWith(result)
    expect(earlierWork(db, latest)).not.toContain('completion receipt')
  })
})
