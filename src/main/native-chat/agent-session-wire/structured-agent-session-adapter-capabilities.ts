import type { StructuredAgentSessionAtRestCommands } from './structured-agent-session-at-rest-commands'

import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type {
  StructuredAgentRegistration,
  StructuredAgentRegistry
} from './structured-agent-registry'
import type { SessionRoute } from './structured-agent-session-acquisition-route'

export function structuredAgentSessionAdapterCapabilities(
  agents: () => StructuredAgentRegistry,
  routes: ReadonlyMap<string, SessionRoute>
) {
  function capabilityOwner(sessionId: string, agent?: string): StructuredAgentRegistration | null {
    const route = routes.get(sessionId)
    if (route?.state === 'live') {
      return route.registration
    }
    return agent ? agents().registration(agent) : null
  }
  const supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean => {
    const adapter = agents().registration(agent)?.adapter
    return adapter ? (adapter.supportsLocation?.(location) ?? false) : false
  }
  const supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    agents()
      .registrations()
      .map((registration) => registration.adapter)
      .some((adapter) => adapter.supportsLocation?.(location) ?? false)
  const rewindSupport: NonNullable<StructuredAgentSessionAdapter['rewindSupport']> = (
    sessionId,
    agent
  ) => {
    const owner = capabilityOwner(sessionId, agent)
    if (!owner?.definition.capabilities.rewind) {
      return { supported: false, reason: 'unsupported' }
    }
    return owner.adapter.rewindSupport?.(sessionId) ?? { supported: true }
  }
  const forkForRewind: NonNullable<StructuredAgentSessionAdapter['forkForRewind']> = (input) =>
    capabilityOwner(input.record.sessionId, input.record.provider)?.adapter.forkForRewind?.(
      input
    ) ?? Promise.resolve({ ok: false, reason: 'unsupported' })
  const nameProviderConversation: NonNullable<
    StructuredAgentSessionAdapter['nameProviderConversation']
  > = (input) =>
    capabilityOwner(
      input.record.sessionId,
      input.record.provider
    )?.adapter.nameProviderConversation?.(input)
  const stopProviderNaming = (): void => {
    for (const adapter of agents()
      .registrations()
      .map((registration) => registration.adapter)) {
      adapter.stopProviderNaming?.()
    }
  }
  const renameProviderSession: NonNullable<
    StructuredAgentSessionAdapter['renameProviderSession']
  > = (input) =>
    capabilityOwner(input.record.sessionId, input.record.provider)?.adapter.renameProviderSession?.(
      input
    ) ?? Promise.resolve()
  const atRestCommands: StructuredAgentSessionAtRestCommands = {
    read: (record) => agents().registration(record.provider)?.adapter.atRestCommands?.read(record),
    snapshot: (record) =>
      agents().registration(record.provider)?.adapter.atRestCommands?.snapshot?.(record) ?? {
        commandsPending: false
      },
    settled: async (record, budgetMs, independent) => {
      const source = agents().registration(record.provider)?.adapter.atRestCommands
      return source?.settled ? source.settled(record, budgetMs, independent) : source?.read(record)
    },
    onChange: (listener) => {
      const stops = agents()
        .registrations()
        .map((registration) => registration.adapter)
        .flatMap((adapter) =>
          adapter.atRestCommands ? [adapter.atRestCommands.onChange(listener)] : []
        )
      return () => stops.forEach((stop) => stop())
    }
  }
  return {
    supportsCreate,
    supportsLocation,
    rewindSupport,
    forkForRewind,
    nameProviderConversation,
    stopProviderNaming,
    renameProviderSession,
    atRestCommands
  }
}
