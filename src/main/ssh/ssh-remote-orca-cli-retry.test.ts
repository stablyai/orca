import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOrchestrationRetryRequestId,
  orchestrationRetryRequestIssuedAtMs
} from '../../shared/orchestration-retry-request-id'
import { createOrchestrationRpcHarness } from '../runtime/rpc/methods/orchestration/rpc-test-harness'
import { CONTROL_GRANTED_SSH_BRIDGE_SCOPE } from './ssh-bridge-caller-scope.test-fixture'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/fixture/app' } }))
vi.mock('../persistence', () => ({ getCanonicalUserDataPath: () => '/fixture/profile' }))

const h = createOrchestrationRpcHarness()
afterEach(() => h.cleanup())

describe('SSH fallback retry declarations', () => {
  it.each([false, true])('declares only an explicit retry (%s)', async (retry) => {
    const { db, runtime, activeRunId } = h.setup()
    const begin = vi.spyOn(db, 'beginMutationReceipt')
    const requestId = createOrchestrationRetryRequestId(Date.now() - 1000)
    db.db
      .prepare('UPDATE mutation_receipt_retirement SET retired_before_ms = ?')
      .run(Date.now() + 60_000)
    const result = await runRemoteOrcaCli(
      runtime,
      {
        callerScope: CONTROL_GRANTED_SSH_BRIDGE_SCOPE,
        argv: [
          'orchestration',
          'check',
          '--run',
          activeRunId ?? '',
          '--json',
          ...(retry ? ['--retry-request', requestId] : [])
        ],
        cwd: '/fixture/workspace',
        env: { ORCA_TERMINAL_HANDLE: 'term_coord', ORCA_PANE_KEY: h.coordinatorPaneKey }
      },
      {
        execPath: '/fixture/electron',
        cliEntryPath: '/fixture/cli.js',
        userDataPath: '/fixture/profile',
        entryExists: () => false
      }
    )
    expect(begin.mock.calls[0]?.[0].requestRetry).toBe(retry ? true : undefined)
    expect(
      orchestrationRetryRequestIssuedAtMs(begin.mock.calls[0]?.[0].requestId ?? '')
    ).not.toBeNull()
    expect(result.exitCode).toBe(retry ? 1 : 0)
    if (retry) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: 'operation_unknown', data: { reason: 'retry_record_retired' } }
      })
    }
  })
})
