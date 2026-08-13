import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

type RoutedAgent = 'claude' | 'codex'

export class StructuredAgentSessionAdapterRouter implements StructuredAgentSessionAdapter {
  private readonly owners = new Map<string, StructuredAgentSessionAdapter>()

  constructor(
    private readonly adapters: Record<RoutedAgent, StructuredAgentSessionAdapter>,
    private readonly closeAdapters: () => Promise<void>
  ) {}

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean => {
    const adapter = this.adapterForAgent(agent)
    return adapter ? (adapter.supportsLocation?.(location) ?? false) : false
  }

  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    Object.values(this.adapters).some((adapter) => adapter.supportsLocation?.(location) ?? false)

  async acquire(input: Parameters<StructuredAgentSessionAdapter['acquire']>[0]) {
    const adapter = this.requireAgent(input.identity)
    const acquired = await adapter.acquire(input)
    this.owners.set(input.identity.sessionId, adapter)
    return acquired
  }

  async releaseAcquisition(input: { sessionId: string }): Promise<void> {
    const adapter = this.owners.get(input.sessionId)
    if (adapter) {
      await adapter.releaseAcquisition?.(input)
      this.owners.delete(input.sessionId)
      return
    }
    for (const candidate of Object.values(this.adapters)) {
      await candidate.releaseAcquisition?.(input)
    }
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) =>
    this.owner(input.sessionId).dispatch(input)

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (input) =>
    this.owner(input.sessionId).cancelTurn(input)

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.owner(input.sessionId).answerPrompt(input)

  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    this.owner(input.sessionId).setOption(input)

  readOptions = (input: { sessionId: string; fence: number }) => {
    const reader = this.owner(input.sessionId).readOptions
    if (!reader) {
      throw new Error(`structured session ${input.sessionId} does not report options`)
    }
    return reader(input)
  }

  historyFilePath = (input: { identity: AgentSessionJournalIdentity }) =>
    this.requireAgent(input.identity).historyFilePath?.(input) ?? Promise.resolve(null)

  async closeSession(sessionId: string): Promise<void> {
    const adapter = this.owners.get(sessionId)
    if (!adapter) {
      return
    }
    await adapter.closeSession?.(sessionId)
    this.owners.delete(sessionId)
  }

  async closeAll(): Promise<void> {
    this.owners.clear()
    await this.closeAdapters()
  }

  private owner(sessionId: string): StructuredAgentSessionAdapter {
    const adapter = this.owners.get(sessionId)
    if (!adapter) {
      throw new Error(`no live structured adapter owns ${sessionId}`)
    }
    return adapter
  }

  private requireAgent(identity: AgentSessionJournalIdentity): StructuredAgentSessionAdapter {
    const adapter = this.adapterForAgent(identity.agent)
    if (!adapter) {
      throw new Error(`structured sessions do not support ${identity.agent}`)
    }
    return adapter
  }

  private adapterForAgent(agent: string): StructuredAgentSessionAdapter | null {
    return agent === 'claude' || agent === 'codex' ? this.adapters[agent] : null
  }
}
