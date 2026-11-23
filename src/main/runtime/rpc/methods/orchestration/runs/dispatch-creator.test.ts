import { describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { resolveDispatchCreator } from './dispatch-creator'

const SESSION = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const CALLER = {
  address: formatOrcaSessionAddress(SESSION),
  terminalHandle: null,
  paneKey: null,
  orcaSessionId: SESSION,
  sessionId: SESSION,
  workspaceId: 'repo::/work'
}

function creatorWhen(conversationTurn: boolean) {
  const turnOf = vi.fn(() => conversationTurn)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveDispatchCreator reads only the conversation seam for a session caller.
  const runtime = {
    getExternalConversationSeam: () => ({ conversationTurn: turnOf })
  } as unknown as OrcaRuntimeService
  return { creator: resolveDispatchCreator(runtime, CALLER.address, CALLER), turnOf }
}

describe('a chat starting a worker', () => {
  it('records that its connector conversation woke the turn, and nothing for a turn begun in Orca', () => {
    const asked = creatorWhen(true)
    expect(asked.creator).toEqual({
      kind: 'session',
      orcaSessionId: SESSION,
      turnSource: 'connector'
    })
    expect(asked.turnOf).toHaveBeenCalledWith(expect.anything(), SESSION)
    expect(creatorWhen(false).creator).toEqual({ kind: 'session', orcaSessionId: SESSION })
  })
})
