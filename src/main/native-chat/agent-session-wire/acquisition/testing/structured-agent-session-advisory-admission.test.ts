import { afterEach, describe, expect, it } from 'vitest'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  type RestTestRig
} from '../../host/testing/structured-agent-session-rest-test-rig'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from '../../host/testing/structured-agent-session-host-test-data'

let rig: RestTestRig | undefined

afterEach(async () => {
  await rig?.dispose()
})

describe('advisory provider admission', () => {
  it.each(['claude', 'codex'] as const)(
    'refuses an unsupported %s adapter before acquisition',
    async (agent) => {
      rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
      const accountHome = {
        variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        path: '/home/dev/advisor-account'
      }
      await rig.store.founding.commit({
        sessionId: HOST_TEST_SESSION,
        location: HOST_TEST_LOCATION,
        provider: agent,
        accountHome,
        expectedFence: null,
        spawnToken: 'spawn-a',
        claimKeyId: 'key-1',
        handoffOperationId: null,
        probe: { outcome: 'pid-absent' },
        operation: {
          callerKey: 'client-1',
          operationId: hostTestOperationId(),
          fingerprint: 'found-advisor'
        },
        now: HOST_TEST_NOW,
        advisoryPolicy: {
          schema: 1,
          dataScope: 'published',
          sourcePin: 'a'.repeat(40),
          deadlineAt: HOST_TEST_NOW + 300_000,
          maxModelCalls: 4,
          artifacts: [
            {
              path: 'note.txt',
              text: 'hello',
              sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
            }
          ]
        }
      })
      const result = await rig.host.attach(
        REST_TEST_CALLER,
        hostTestAttachParams(1, {
          agent,
          provider: agent,
          accountHome,
          providerHandle: undefined
        })
      )
      expect(result).toMatchObject({
        ok: false,
        refusal: {
          code: 'structured_agent_session_unsupported',
          details: { reason: 'hostUnsupported' }
        }
      })
      expect(rig.adapter.acquire).not.toHaveBeenCalled()
      expect(rig.store.getRecord(HOST_TEST_SESSION)?.lease.claimStatus).toBe('released')
    }
  )
})
