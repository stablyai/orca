// A stand-in for the connector seam and the machine around it, recording each call a client makes.
import { vi } from 'vitest'
import type { ConnectorProject } from '../../shared/connector-cloud-contract'
import type {
  ConversationEvent,
  ConversationWatchListener
} from '../external-conversations/external-conversation-events'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import type { Delivery } from '../external-conversations/external-conversation-types'
import type { ConnectorMachine } from './connector-machine'

export type FakeSeam = ReturnType<typeof fakeSeam>

/** The seam calls a client makes, answered from `outcomes` (accepted by default). */
export function fakeSeam() {
  const disabled = new AbortController()
  const watchers = new Set<ConversationWatchListener>()
  const outcomes = new Map<string, Promise<Delivery>>()
  const recorded = new Map<string, Delivery>()
  const outcome = async (id: string): Promise<Delivery> =>
    (await outcomes.get(id)) ?? { outcome: 'accepted' }
  const seam = {
    signal: disabled.signal,
    start: vi.fn(async (_host: unknown, key: unknown, id: string) => ({
      conversation: key,
      initial: await outcome(id)
    })),
    send: vi.fn((_host: unknown, _key: unknown, id: string) => outcome(id)),
    answer: vi.fn((): Promise<Delivery> => {
      throw new Error('external_conversation_not_found')
    }),
    cancel: vi.fn((_host: unknown, _key: unknown, id: string) => outcome(id)),
    recorded: vi.fn(async (_key: unknown, id: string) => recorded.get(id) ?? null),
    watch: vi.fn((_host: unknown, listener: ConversationWatchListener) => {
      listener({ kind: 'snapshot', conversations: [] })
      watchers.add(listener)
      return () => watchers.delete(listener)
    })
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the client calls only these seam members.
    seam: seam as unknown as ExternalConversationSeam,
    calls: seam,
    outcomes,
    recorded,
    emit: (event: ConversationEvent) => watchers.forEach((listener) => listener(event)),
    disable: () => disabled.abort('connectors_disabled')
  }
}

/** `current` is the seam while connectors are on, null while they are off. */
export function fakeMachine(
  current: () => FakeSeam | null,
  projects: ConnectorProject[] = []
): ConnectorMachine & { toggle: () => void; agentList: string[] } {
  const toggled = new Set<() => void>()
  const machine: ConnectorMachine & { toggle: () => void; agentList: string[] } = {
    /** What `agents()` reports; tests change it to model a settings change. */
    agentList: ['claude', 'codex'],
    runtime: 'desktop',
    hostName: 'box',
    orcaVersion: '1.4.250',
    seam: () => current()?.seam ?? null,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake seam never reads its host.
    conversationHost: () => ({}) as ReturnType<ConnectorMachine['conversationHost']>,
    agents: () => machine.agentList,
    projects: () => projects,
    onConnectorsToggled: (listener) => {
      toggled.add(listener)
    },
    toggle: () => toggled.forEach((listener) => listener())
  }
  return machine
}
