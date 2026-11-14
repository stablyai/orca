import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { withTestAgentSessionDatabase } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from '../structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host.test-fixture'
import { hostTestMessage } from './structured-agent-session-host-test-data.test-fixture'

let root: string
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>

beforeEach(() => {
  ;({ root, host, dispatch } = hostTestState())
})

afterEach(() => vi.restoreAllMocks())

function sendParams(text: string, clientOperationId?: string) {
  const body = hostTestMessage(text)
  return {
    envelope: envelope(
      'agentSession.send',
      { body },
      clientOperationId ? { clientOperationId } : {}
    ),
    body
  }
}

describe('send without ledger policy', () => {
  it('replays accepted ids after the compatibility ledger has expired', async () => {
    await attach()
    const params = sendParams('receipt survives the ledger')
    await host.send(CALLER, params)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    await withTestAgentSessionDatabase(root, (db) =>
      db.prepare('DELETE FROM agent_session_operations').run()
    )
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
