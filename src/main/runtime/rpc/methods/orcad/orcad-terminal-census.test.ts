import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../core'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'

vi.mock('../../../../orcad/diagnostics/orcad-terminal-census', () => ({
  collectOrcadTerminalCensus: async () => ({
    liveSessions: 0,
    startedSinceActivation: 0,
    daemonProtocolVersion: null,
    inProcessSessions: 0
  })
}))

const { ORCAD_TERMINAL_CENSUS_METHODS } = await import('./orcad-terminal-census')

function censusMethod() {
  const method = eraseRpcMethods(ORCAD_TERMINAL_CENSUS_METHODS)[0]
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing census method')
  }
  return method
}

function context(): RpcContext {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a census without release or admission reads no runtime member.
    runtime: {} as OrcaRuntimeService,
    clientKind: 'runtime',
    pairedDeviceId: 'paired-desktop'
  }
}

describe('orcad.terminalCensus chat sessions', () => {
  afterEach(() => setStructuredAgentSessionHost(null))

  it('reports native chats whose providers live in orcad', async () => {
    setStructuredAgentSessionHost(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only loadedSessionIds.
      { loadedSessionIds: () => ['chat-1'] } as unknown as StructuredAgentSessionHost
    )
    const method = censusMethod()
    const census = await method.handler(method.params?.parse({ activatedAt: 1 }), context())
    expect(census).toMatchObject({ liveSessions: 0, chatSessions: 1 })
  })

  it('reports zero chats when no chat host is installed', async () => {
    const method = censusMethod()
    const census = await method.handler(method.params?.parse({ activatedAt: 1 }), context())
    expect(census).toMatchObject({ chatSessions: 0 })
  })
})
