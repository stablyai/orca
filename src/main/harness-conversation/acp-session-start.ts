import {
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type ClientSideConnection,
  type SessionConfigOption,
  type SessionModeState
} from '@agentclientprotocol/sdk'

export async function startAcpSession(input: {
  connection: ClientSideConnection
  cwd: string
  providerSessionId: string | null
  forkFromProviderSessionId: string | null
}): Promise<{
  capabilities: AgentCapabilities
  sessionId: string
  modes: SessionModeState | null
  configOptions: SessionConfigOption[]
}> {
  const initialized = await input.connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { session: { configOptions: { boolean: {} } } },
    clientInfo: { name: 'Orca', version: '0.0.0' }
  })
  const capabilities = initialized.agentCapabilities ?? {}
  if (input.forkFromProviderSessionId) {
    if (!capabilities.sessionCapabilities?.fork) {
      throw new Error('acp_fork_unsupported')
    }
    const result = await input.connection.unstable_forkSession({
      sessionId: input.forkFromProviderSessionId,
      cwd: input.cwd,
      mcpServers: []
    })
    return sessionResult(capabilities, result.sessionId, result)
  }
  if (input.providerSessionId) {
    if (capabilities.sessionCapabilities?.resume) {
      const result = await input.connection.resumeSession({
        sessionId: input.providerSessionId,
        cwd: input.cwd,
        mcpServers: []
      })
      return sessionResult(capabilities, input.providerSessionId, result)
    }
    if (!capabilities.loadSession) {
      throw new Error('acp_resume_unsupported')
    }
    await input.connection.loadSession({
      sessionId: input.providerSessionId,
      cwd: input.cwd,
      mcpServers: []
    })
    return sessionResult(capabilities, input.providerSessionId, {})
  }
  const result = await input.connection.newSession({ cwd: input.cwd, mcpServers: [] })
  return sessionResult(capabilities, result.sessionId, result)
}

function sessionResult(
  capabilities: AgentCapabilities,
  sessionId: string,
  result: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null }
) {
  return {
    capabilities,
    sessionId,
    modes: result.modes ?? null,
    configOptions: result.configOptions ?? []
  }
}
