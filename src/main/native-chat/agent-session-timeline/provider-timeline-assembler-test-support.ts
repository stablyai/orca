// A real assembled lane for tests: grammar events → assembler → deferred sink queue → on-disk
// journal. Assertions read the journal back, so they check what a client sees.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalApprovalItem,
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalToolCallItem,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { backgroundTaskFallbackText } from '../../../shared/native-chat-background-task-row'
import {
  isBackgroundTaskBlock,
  type NativeChatBackgroundTaskBlock
} from '../../../shared/native-chat-types'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventSink
} from '../agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../agent-session-wire/structured-agent-session-logger-test-support'
import {
  createProviderTimelineAssembler,
  type ProviderTimelineAssembler,
  type ProviderTimelineAssemblerDeps
} from './provider-timeline-assembler'
import { settleStaleStructuredAgentSessionState } from '../agent-session-wire/structured-agent-session-dead-generation-settlement'
import {
  createLegacyProviderTimelineIdentityScheme,
  type ProviderTimelineItemFamily
} from './provider-timeline-identity'
import { providerTimelineSink, type ProviderTimelineSink } from './provider-timeline-plan'

export const SESSION = 'session-timeline'
export const AGENT = 'grok'
export const GENERATION = 'gen-1'
export const NAMESPACE = 'provider-session-1'

const scheme = createLegacyProviderTimelineIdentityScheme({ agent: AGENT, sessionId: SESSION })

/** The journal key the assembler gives a provider-keyed item, or a request of `generation`. */
export function providerItemId(
  family: ProviderTimelineItemFamily | 'request',
  key: string,
  options: { namespace?: string; thread?: string; generation?: string; incarnation?: number } = {}
): string {
  return agentJournalItemKey(
    family === 'request'
      ? scheme.request({
          generation: options.generation ?? GENERATION,
          key,
          incarnation: options.incarnation ?? 1
        })
      : scheme.item({
          namespace: options.namespace ?? NAMESPACE,
          family,
          key: { source: 'provider', value: key },
          thread: options.thread ?? null
        })
  )
}

/** The journal key of a provider-keyed turn's row. */
export function providerTurnItemId(turnKey: string, namespace = NAMESPACE): string {
  return agentJournalItemKey(
    scheme.turn({ namespace, key: { source: 'provider', value: turnKey } })
  )
}

/** The turn id a provider-keyed turn's row carries. */
export function providerTurnId(turnKey: string, namespace = NAMESPACE): string {
  return scheme.turnId({ namespace, key: { source: 'provider', value: turnKey } })
}

export function runningTool(name: string): AgentJournalToolCallItem {
  return { kind: 'tool-call', name, input: { name }, state: 'running' }
}

/** A background task's row as every lane writes it: its plain-text twin, then its block. */
export function backgroundTask(
  taskId: string,
  state: NativeChatBackgroundTaskBlock['state']
): AgentJournalMessageItem {
  const block: NativeChatBackgroundTaskBlock = {
    type: 'background-task',
    taskId,
    kind: 'command',
    label: taskId,
    state
  }
  return {
    kind: 'message',
    role: 'system',
    blocks: [{ type: 'text', text: backgroundTaskFallbackText(block) }, block]
  }
}

/** The run state of the background task in the row of provider item `item`. */
export async function backgroundTaskState(
  rig: ProviderTimelineRig,
  item: string
): Promise<string | undefined> {
  const body = (await rig.row(providerItemId('item', item)))?.body
  const block = body?.kind === 'message' ? body.blocks.find(isBackgroundTaskBlock) : undefined
  return block?.state
}

export function assistantText(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

export const pendingApproval: AgentJournalApprovalItem = {
  kind: 'approval',
  title: 'Run?',
  detail: null,
  options: [{ id: 'allow', label: 'Allow' }],
  resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
}

export function messageText(body: AgentJournalItemBody | undefined): string | undefined {
  return body?.kind === 'message' && body.blocks[0]?.type === 'text'
    ? body.blocks[0].text
    : undefined
}

const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []

/** Call from `afterEach`. */
export async function closeProviderTimelineRigs(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  await journals.closeAll()
}

/** An assembler whose sink binds to the rig's journal only when `bind` is called, as a lane that
 *  starts before its journal opens (a resume): it admits events without the journal's view. */
export type UnboundProviderTimelineAssembler = {
  assembler: ProviderTimelineAssembler
  bind(): Promise<void>
  drained(): Promise<void>
}

export function openUnboundProviderTimelineAssembler(
  journal: AgentSessionJournal,
  overrides: Partial<ProviderTimelineAssemblerDeps> = {}
): UnboundProviderTimelineAssembler {
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  const sink = providerTimelineSink(deferred.sink)
  if (!sink) {
    throw new Error('the deferred sink offers transitions')
  }
  const assembler = createProviderTimelineAssembler({
    sink,
    sessionId: SESSION,
    agent: AGENT,
    generation: 'gen-unbound',
    namespace: NAMESPACE,
    // The window never fires on its own; `flush` writes what it holds.
    schedule: () => () => {},
    ...overrides
  })
  cleanups.push(async () => {
    assembler.dispose()
    deferred.close()
  })
  return {
    assembler,
    bind: async () => {
      deferred.bind({ journal, fence: 1, publish: () => {} })
      await deferred.drained()
    },
    drained: async () => {
      await deferred.drained()
    }
  }
}

export type ProviderTimelineRig = {
  journal: AgentSessionJournal
  /** The current child's assembler; `restart` replaces it. */
  assembler: ProviderTimelineAssembler
  sink: ProviderTimelineSink
  /** The same journal's event sink, for a lane that writes it directly. */
  eventSink: StructuredAgentSessionEventSink
  /** What a restarted host does: the old child's assembler is gone (text still in its window is
   *  lost, as `dispose` drops it), the dead-generation sweep settles what it left, then a new
   *  child gets a new assembler in a new generation, which becomes `assembler`. */
  restart(overrides?: Partial<ProviderTimelineAssemblerDeps>): Promise<ProviderTimelineAssembler>
  /** Another assembler of the same generation on the same journal, for a test that needs its own
   *  sink; the rig's own assembler must then stay unused. */
  assemble(overrides?: Partial<ProviderTimelineAssemblerDeps>): ProviderTimelineAssembler
  rows(): Promise<AgentJournalRenderItem[]>
  row(itemId: string): Promise<AgentJournalRenderItem | undefined>
  /** The turn row of provider turn `turnKey`, or the row whose turn id is `turnKey`. */
  turn(turnKey: string, namespace?: string): Promise<AgentJournalTurnLifecycle | undefined>
  turns(): Promise<AgentJournalTurnLifecycle[]>
}

/** The rig's sink with its transitions refused while `refusing()` holds. */
export function refusingSink(
  sink: ProviderTimelineSink,
  refusing: () => boolean,
  reason: 'backpressure' | 'failed' = 'backpressure'
): ProviderTimelineSink {
  return {
    ...sink,
    tryAppendTransition: (transition) =>
      refusing() ? { accepted: false, reason } : sink.tryAppendTransition(transition)
  }
}

export async function openProviderTimelineRig(
  overrides: Partial<ProviderTimelineAssemblerDeps> = {}
): Promise<ProviderTimelineRig> {
  const root = await mkdtemp(join(tmpdir(), 'orca-provider-timeline-'))
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: AGENT,
      providerHandle: { transport: 'acp', agent: AGENT, nativeId: 'provider-session-1' }
    },
    stateDirectory: root,
    now: () => 1_000
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: () => {} })
  cleanups.push(async () => {
    deferred.close()
    await rm(root, { recursive: true, force: true })
  })
  const sink = providerTimelineSink(deferred.sink)
  if (!sink) {
    throw new Error('the deferred sink offers transitions')
  }
  // The coalescing window elapses before every read, so all text streamed so far is written,
  // unless a test overrides `schedule` to drive the window itself.
  const windows = new Set<() => void>()
  const elapse = () => {
    // Only the windows open now: a flush the sink refused schedules another for the next read.
    const due = Array.from(windows)
    windows.clear()
    due.forEach((run) => run())
  }
  const build = (more: Partial<ProviderTimelineAssemblerDeps> = {}) =>
    createProviderTimelineAssembler({
      sink,
      sessionId: SESSION,
      agent: AGENT,
      generation: GENERATION,
      namespace: NAMESPACE,
      schedule: (run) => {
        windows.add(run)
        return () => windows.delete(run)
      },
      ...overrides,
      ...more
    })
  const rows = async () => {
    elapse()
    await deferred.drained()
    return journal.snapshot().items
  }
  const turns = async () =>
    (await rows()).flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn ? [turn] : []
    })
  let generations = 1
  const rig: ProviderTimelineRig = {
    journal,
    assembler: build(),
    sink,
    eventSink: deferred.sink,
    restart: async (more = {}) => {
      generations += 1
      const generation = more.generation ?? `gen-${generations}`
      // The dead child's window never elapses: as in production, dispose drops its text.
      await deferred.drained()
      rig.assembler.dispose()
      await settleStaleStructuredAgentSessionState({
        journal,
        sessionId: SESSION,
        fence: 1,
        acquisitionGeneration: generation,
        deathEvidence: null
      })
      rig.assembler = build({ ...more, generation })
      return rig.assembler
    },
    assemble: build,
    rows,
    row: async (itemId) => (await rows()).find((item) => item.itemId === itemId),
    turns,
    turn: async (turnKey, namespace) => {
      const all = await turns()
      return (
        all.find((turn) => turn.turnId === providerTurnId(turnKey, namespace)) ??
        all.find((turn) => turn.turnId === turnKey)
      )
    }
  }
  return rig
}
