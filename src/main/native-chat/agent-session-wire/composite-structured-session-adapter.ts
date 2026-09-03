import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'

/** Routes Codex through the existing app-server adapter and everyone else through ACP. */
export class CompositeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  constructor(
    private readonly adapters: {
      codex: StructuredAgentSessionAdapter
      acp: StructuredAgentSessionAdapter
    }
  ) {}

  private forAgent(agent: string): StructuredAgentSessionAdapter {
    return agent === 'codex' ? this.adapters.codex : this.adapters.acp
  }

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean => {
    return this.forAgent(agent).supportsCreate?.(location, agent) ?? false
  }

  supportsLocation = (location: AgentSessionExecutionLocation): boolean => {
    return (
      (this.adapters.codex.supportsLocation?.(location) ?? false) ||
      (this.adapters.acp.supportsLocation?.(location) ?? false)
    )
  }

  acquire = async (input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> => {
    const adapter = this.forAgent(input.identity.agent)
    const acquired = await adapter.acquire(input)
    this.owners.set(input.identity.sessionId, adapter)
    return acquired
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = (input) => {
    const adapter = this.liveAdapter(input.sessionId)
    return adapter.dispatch(input)
  }

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = (input) =>
    this.liveAdapter(input.sessionId).cancelTurn(input)

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.liveAdapter(input.sessionId).answerPrompt(input)

  setOption: StructuredAgentSessionAdapter['setOption'] = (input) =>
    this.liveAdapter(input.sessionId).setOption(input)

  readOptions: NonNullable<StructuredAgentSessionAdapter['readOptions']> = (input) => {
    const reader = this.liveAdapter(input.sessionId).readOptions
    return reader ? reader(input) : Promise.resolve({ models: [], current: { model: '' } })
  }

  closeSession = (sessionId: string): Promise<boolean> =>
    this.closeOn(sessionId, (adapter) => adapter.closeSession?.(sessionId) ?? Promise.resolve(true))

  forceCloseSession = (sessionId: string): Promise<boolean> =>
    this.closeOn(
      sessionId,
      (adapter) => adapter.forceCloseSession?.(sessionId) ?? Promise.resolve(true)
    )

  disposeSession = (sessionId: string): Promise<boolean> =>
    this.closeOn(
      sessionId,
      (adapter) => adapter.disposeSession?.(sessionId) ?? Promise.resolve(true)
    )

  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.closeOn(
      input.sessionId,
      (adapter) => adapter.releaseAcquisition?.(input) ?? Promise.resolve(true)
    )

  async closeAll(): Promise<void> {
    const close = async (adapter: StructuredAgentSessionAdapter): Promise<void> => {
      const closeAll = (adapter as { closeAll?: () => Promise<void> }).closeAll
      if (closeAll) {
        await closeAll()
      }
    }
    await Promise.all([close(this.adapters.codex), close(this.adapters.acp)])
  }

  private readonly owners = new Map<string, StructuredAgentSessionAdapter>()

  private liveAdapter(sessionId: string): StructuredAgentSessionAdapter {
    return this.owners.get(sessionId) ?? this.adapters.acp
  }

  private closeOn(
    sessionId: string,
    run: (adapter: StructuredAgentSessionAdapter) => Promise<boolean>
  ): Promise<boolean> {
    const adapter = this.liveAdapter(sessionId)
    return run(adapter).finally(() => {
      this.owners.delete(sessionId)
    })
  }
}
