import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('worker-start --terminal with --agent', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => h.setup())
  afterEach(() => h.cleanup())

  it('refuses, saying --terminal continues the running agent, before any Dispatch', async () => {
    await expect(
      h.call('orchestration.workerStart', {
        from: 'term_coord',
        terminal: 'term_worker',
        agent: 'codex',
        spec: 'reuse the worker'
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        '--terminal continues the agent already running there, in its current conversation. To start fresh, use --worktree or --agent without --terminal.'
    })
    expect(h.db.db.prepare('SELECT count(*) AS n FROM dispatch_contexts').get()).toEqual({ n: 0 })
  })
})
