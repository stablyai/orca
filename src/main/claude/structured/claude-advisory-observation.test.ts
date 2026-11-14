import { expect, it, vi, afterEach } from 'vitest'
import { createClaudeAdvisoryObservation } from './claude-advisory-observation'
import type { AgentSessionAdvisoryObservation } from '../../../shared/agent-session/agent-session-advisory-receipt'

afterEach(() => vi.restoreAllMocks())

// SDK envelope fixtures exercise observation handling, not native call-limit qualification.
it('keeps query-pipeline usage separate from unknown helpers and counts repeated response frames once', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1800000000000)
  const snapshots: AgentSessionAdvisoryObservation[] = []
  const stopped: (Error | undefined)[] = []
  const binding = {
    accountFingerprint: `claude:${'b'.repeat(64)}`,
    model: 'model-fixture',
    effort: 'high'
  }
  const policy = {
    schema: 2 as const,
    dataScope: 'published' as const,
    sourcePin: 'a'.repeat(40),
    deadlineAt: 1800000030000,
    maxModelCalls: 4,
    binding,
    artifacts: [
      {
        path: 'note',
        text: 'hello',
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      }
    ]
  }
  const observed = createClaudeAdvisoryObservation(
    policy,
    (value) => snapshots.push(value),
    (error) => stopped.push(error)
  )
  observed.binding({ ...binding, plan: 'max' }, true)
  observed.admitted()
  const message = { type: 'assistant', message: { id: 'message-one', model: 'model-fixture' } }
  observed.message(message)
  observed.message(message)
  observed.reported()
  observed.message({
    type: 'result',
    subtype: 'success',
    modelUsage: {
      'model-fixture': {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 12,
        cacheCreationInputTokens: 3,
        private_detail: 'do-not-retain'
      }
    }
  })
  expect(snapshots.at(-1)).toMatchObject({
    invalidated: false,
    turnCompleted: true,
    execution: {
      bounded: { modelCalls: 1 },
      usage: {
        scope: 'query-pipeline',
        auxiliaryCoverage: 'partial',
        models: [
          {
            model: 'model-fixture',
            inputTokens: 10,
            outputTokens: 4,
            cacheReadInputTokens: 12,
            cacheCreationInputTokens: 3
          }
        ]
      }
    }
  })
  expect(JSON.stringify(snapshots)).not.toContain('do-not-retain')
  expect(snapshots.at(-1)?.execution.usage?.models[0]).not.toHaveProperty('thinkingTokens')
  expect(snapshots.at(-1)).not.toHaveProperty('closure')
  observed.closure({ root: 'exited', tree: 'unverifiable', observedAt: 1800000002000 })
  expect(snapshots.at(-1)?.closure).toEqual({
    root: 'exited',
    tree: 'unverifiable',
    observedAt: 1800000002000
  })
  expect(stopped).toEqual([undefined])
})
