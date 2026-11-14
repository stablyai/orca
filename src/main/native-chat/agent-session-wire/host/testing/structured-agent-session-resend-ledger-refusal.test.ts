import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { openTestJournalHostDatabase } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import type { StructuredAgentSessionHost } from '../structured-agent-session-host'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import { hostTestMessage } from './structured-agent-session-host-test-data'

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
    const db = openTestJournalHostDatabase(root).db
    db.prepare('DELETE FROM agent_session_operations').run()
    await expect(host.send(CALLER, params)).resolves.toMatchObject({ ok: true, replayed: true })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
