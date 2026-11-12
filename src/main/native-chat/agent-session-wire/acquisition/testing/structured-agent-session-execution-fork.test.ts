import { expect, it } from 'vitest'
import { forkTestSource } from './structured-agent-session-fork.test-fixture'
import { createRestTestRig } from '../../host/testing/structured-agent-session-rest-test-rig'

it('refuses to turn a bounded Codex source into an unbounded fork', async () => {
  const rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  try {
    const source = forkTestSource(rig)
    source.record.executionPolicy = {
      schema: 1,
      sourcePin: 'a'.repeat(40),
      accountFingerprint: `codex:${'b'.repeat(64)}`,
      model: 'gpt-live',
      effort: 'low',
      access: 'read-only',
      deadlineAt: 1_800_000_120_000
    }
    await expect(source.prepare()).rejects.toMatchObject({
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'advisoryOperationUnsupported' }
      }
    })
  } finally {
    await rig.dispose()
  }
})
