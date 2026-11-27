import { takeAcpKeptVersionSkip } from '../launch/acp-launch-version'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { acpKeptToolsDiffer, acpLaunchNote } from './acp-kept-launch-permission'
import type { ProviderRelayKeepSpec } from '../../daemon/protocol/daemon-provider-relay-protocol'
import {
  launchRelayedProviderProcess,
  type ProviderRelayLaunch,
  type RelayedProviderProcess
} from '../../provider-relay/app-provider-relays'
import { readProcessStartTimeMs } from '../../runtime/agent-session/ownership/agent-session-process-identity-probe'
import { acpRelayFloors, type AcpRelayTurns } from './acp-relay-turns'
import { acpRelayWorkMarkers, acpSpecRelays } from './acp-relay-work-markers'
import type { RelayedProviderChild } from '../../provider-relay/relayed-provider-child'
import { isJsonRpcAnswerAbove, jsonRpcResultOf } from '../../provider-relay/relayed-json-rpc-lines'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import { AgentSessionPreSpawnError } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import {
  ACP_PROTOCOL_VERSION,
  InitializeResponseSchema,
  type InitializeResponse
} from '../generated/acp-protocol.generated'
import { keptAcpSessionStart, type AcpSessionStarted } from '../protocol/acp-session-setup'
import type { AcpStructuredSessionAdapterDeps } from '../session/acp-structured-session-adapter-deps'
import type { StructuredAgentSessionAcquireInput } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AcpStructuredLaunch } from '../launch/acp-structured-launch-resolution'

const SESSION_STARTS = ['session/new', 'session/load', 'session/resume']
const SET_CONFIG = 'session/set_config_option'
const SET_MODEL = 'session/set_model'
const PROMPT = 'session/prompt'
const STATE_UPDATES = ['config_option_update', 'current_mode_update', 'available_commands_update']

/** Session state the daemon keeps for the next app: the start answer and the latest state updates.
 *  Markers name the update kind as a JSON key and value, so text inside a string never matches. */
const ACP_RELAY_KEEP: ProviderRelayKeepSpec = {
  answers: [...SESSION_STARTS, SET_CONFIG],
  lines: STATE_UPDATES.flatMap((kind) => [
    `"sessionUpdate":"${kind}"`,
    `"sessionUpdate": "${kind}"`
  ]),
  // An unanswered prompt is a running turn; the daemon never idle-stops it.
  outstanding: [PROMPT],
  // Its answer is empty, so the model the user picked is read from the request.
  requests: [SET_MODEL]
}

/** With the dialect's fixed housekeeping replies; never one for a request Orca shows the person. */
function acpRelayKeep(dialect: AcpLaunchSpec['dialect']): ProviderRelayKeepSpec {
  const replies = Object.entries(dialect.detachedReplies ?? {}).filter(
    ([method]) => dialect.request?.(method, {}) === undefined
  )
  return replies.length > 0
    ? { ...ACP_RELAY_KEEP, replies: Object.fromEntries(replies) }
    : ACP_RELAY_KEEP
}

/** A pid's start time; a kept agent that ended while Orca was closed still hands on its output,
 *  under a start time no live process has, so recovery never mistakes another one for it. */
export const keptAcpStartTime =
  (relayed: AcpRelayedProcess | null, read = readProcessStartTimeMs) =>
  async (pid: number): Promise<number | null> =>
    relayed && (relayed.child.exited ?? relayed.child.attachResult?.exit) ? 0 : await read(pid)

/** A kept state change, replayed as the `session/update` the agent sent or implied. */
export type AcpKeptUpdate = { sessionId: string | undefined; update: Record<string, unknown> }

/** What a reattached agent already did for the app that started it. */
export type AcpKeptAgent = {
  /** The earlier app's highest request id; this app's ids start above it. */
  requestFloor: number
  initialize: InitializeResponse | null
  /** The latest session start the agent answered. */
  sessionStart: { method: string; result: unknown } | null
  /** State changes since that start, oldest first. */
  updates: AcpKeptUpdate[]
  /** The earlier app's latest prompt the agent still owes or answers in the replay; null: none. */
  earlierPromptId: number | null
  /** Every line the agent sent for that prompt is in the replay, so its turn reads as live. */
  earlierPromptWhole: boolean
  /** The model picked since that start; null: the start's own. */
  modelId: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A kept line as a state update: a listed `session/update`, or a config write's answer. */
function keptUpdate(name: string, line: string): AcpKeptUpdate | null {
  if (name === `a:${SET_CONFIG}`) {
    const result = jsonRpcResultOf(line)
    return isRecord(result) && Array.isArray(result.configOptions)
      ? {
          sessionId: undefined,
          update: { sessionUpdate: 'config_option_update', configOptions: result.configOptions }
        }
      : null
  }
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(message) || message.method !== 'session/update' || !isRecord(message.params)) {
    return null
  }
  const { sessionId, update } = message.params
  return isRecord(update) &&
    typeof update.sessionUpdate === 'string' &&
    STATE_UPDATES.includes(update.sessionUpdate)
    ? { sessionId: typeof sessionId === 'string' ? sessionId : undefined, update }
    : null
}

/** Read once per attach: the launch and the session both use it. */
const keptAgents = new WeakMap<RelayedProviderChild, AcpKeptAgent>()

export function acpKeptAgent(child: RelayedProviderChild): AcpKeptAgent {
  let kept = keptAgents.get(child)
  if (!kept) {
    kept = readKeptAgent(child)
    keptAgents.set(child, kept)
  }
  return kept
}

function readKeptAgent(child: RelayedProviderChild): AcpKeptAgent {
  const attach = child.attachResult
  let sessionStart: (AcpKeptAgent['sessionStart'] & { seq: number }) | null = null
  const updates: { seq: number; update: AcpKeptUpdate }[] = []
  let model: { seq: number; id: string } | null = null
  for (const { seq, name } of attach?.kept ?? []) {
    const line = child.kept.lines.get(seq)
    if (line === undefined) {
      continue
    }
    if (name === `q:${SET_MODEL}`) {
      const id = keptModelId(line)
      model = id === null ? model : { seq, id }
      continue
    }
    const method = name.startsWith('a:') ? name.slice(2) : null
    if (method && SESSION_STARTS.includes(method)) {
      if (!sessionStart || seq > sessionStart.seq) {
        sessionStart = { method, result: jsonRpcResultOf(line), seq }
      }
      continue
    }
    const update = keptUpdate(name, line)
    if (update) {
      updates.push({ seq, update })
    }
  }
  const startSeq = sessionStart?.seq ?? Number.POSITIVE_INFINITY
  const prompt = (attach?.outstanding ?? []).findLast((request) => request.method === PROMPT)
  const initialize = InitializeResponseSchema.safeParse(jsonRpcResultOf(child.initializeLine))
  return {
    requestFloor: attach?.maxClientRequestId ?? 0,
    initialize:
      initialize.success && initialize.data.protocolVersion === ACP_PROTOCOL_VERSION
        ? initialize.data
        : null,
    sessionStart: sessionStart && { method: sessionStart.method, result: sessionStart.result },
    // An update naming its session may come while the agent answers the start (Grok's commands);
    // only one that doesn't (a config answer) must follow the start to be its state.
    updates: updates
      .filter((entry) => entry.seq > startSeq || entry.update.sessionId !== undefined)
      .sort((a, b) => a.seq - b.seq)
      .map((entry) => entry.update),
    earlierPromptId: typeof prompt?.id === 'number' ? prompt.id : null,
    earlierPromptWhole: prompt?.replayedWhole === true,
    modelId: model && model.seq > startSeq ? model.id : null
  }
}

function keptModelId(line: string): string | null {
  try {
    const message: unknown = JSON.parse(line)
    const params = isRecord(message) && isRecord(message.params) ? message.params : null
    return typeof params?.modelId === 'string' ? params.modelId : null
  } catch {
    return null
  }
}

/** The kept session, when everything needed to carry on without asking the agent again was kept. */
export function restorableAcpSession(
  kept: AcpKeptAgent,
  sessionId: string | undefined
): AcpSessionStarted | null {
  // One that ended while Orca was closed still opens, so its last output reaches the chat first.
  const { initialize, sessionStart, modelId } = kept
  if (!initialize || !sessionStart) {
    return null
  }
  // The start reports the model it opened with; a later pick is the one the agent runs.
  const result = isRecord(sessionStart.result) ? sessionStart.result : null
  const models = result && isRecord(result.models) ? result.models : null
  return keptAcpSessionStart(
    result && models && modelId !== null
      ? { ...sessionStart, result: { ...result, models: { ...models, currentModelId: modelId } } }
      : sessionStart,
    sessionId
  )
}

/** A relayed ACP agent with the prompt turns its ack floor reads. */
export type AcpRelayedProcess = RelayedProviderProcess & {
  turns: AcpRelayTurns
  /** Reattached for a launch whose app-bound tools it lacks: the next send goes to a fresh agent. */
  freshOwed?: true
}

/**
 * Starts a chat's agent under the terminal daemon, or reattaches the one it kept running, so it
 * outlives a restart. Null: relaying isn't available here, and the caller launches as today. A
 * kept agent whose session can't be restored from what was kept is ended rather than reloaded (a
 * reload replays history and may replace the live session), and the chat cold-starts.
 */
export async function launchRelayedAcpAgent(
  input: {
    deps: Pick<AcpStructuredSessionAdapterDeps, 'spec' | 'logger'>
    acquire: Pick<StructuredAgentSessionAcquireInput, 'identity'>
    abandoned: () => boolean
  },
  /** `resume`: the session the chat reopens; a kept agent running another one can't carry on. */
  launch: Pick<
    AcpStructuredLaunch,
    'resume' | 'release' | 'appBoundGrants' | 'fullAccess' | 'toolFree' | 'toolsKey'
  >,
  processLaunch: ProviderProcessLaunch
): Promise<AcpRelayedProcess | null> {
  const { spec } = input.deps
  const versionSkipped = takeAcpKeptVersionSkip(input.acquire.identity.sessionId)
  if (!acpSpecRelays(spec)) {
    return null
  }
  // A bot's tool grants live only in this app and a tool-free run's folder goes with its launch, so
  // neither starts a kept agent; the chat's kept one is still reattached, never a second beside it,
  // and owes a fresh agent at its next send.
  const appBound = launch.appBoundGrants === true || launch.toolFree !== undefined
  const refuse = async (refused: unknown): Promise<never> => {
    // Nothing of this launch ran, so its files go.
    await launch.release?.().catch(() => undefined)
    throw new AgentSessionPreSpawnError(refused)
  }
  // Answers to this app's own requests pass a reattach's hold; everything else waits for the chat.
  let floor = Number.POSITIVE_INFINITY
  const { turns, continuation, ackFloor } = acpRelayFloors(Boolean(spec.dialect.childSessionStop))
  const relay: ProviderRelayLaunch = {
    chatKey: input.acquire.identity.sessionId,
    markers: { ...acpRelayWorkMarkers(spec.agent), ackFloor, continuation },
    keep: {
      ...acpRelayKeep(spec.dialect),
      note: acpLaunchNote(launch.fullAccess, launch.toolsKey)
    },
    passWhileHeld: (line) => isJsonRpcAnswerAbove(line, floor),
    ...(appBound ? { only: 'reattach' as const } : {})
  }
  const relayed = await launchRelayedProviderProcess(processLaunch, relay).catch(refuse)
  floor = relayed?.child.attachResult?.maxClientRequestId ?? 0
  const sessionId = launch.resume?.sessionId
  // The kept agent ended before the attach: this launch never checked its version or chose its
  // instructions by it, so it goes, and the chat's next message launches afresh.
  if (!relayed?.reattached && versionSkipped) {
    await relayed?.managed.close().catch(() => undefined)
    return refuse(new Error('agent_kept_running_gone'))
  }
  const kept = relayed?.reattached ? acpKeptAgent(relayed.child) : null
  if (relayed && kept && !restorableAcpSession(kept, sessionId)) {
    input.deps.logger?.warn('a kept ACP agent cannot carry on its chat', {
      scope: 'acp-kept-unrestorable',
      sessionId: input.acquire.identity.sessionId,
      agent: spec.agent,
      initialize: kept.initialize !== null,
      start: kept.sessionStart?.method ?? null,
      resume: sessionId !== undefined,
      kept: relayed.child.attachResult?.kept?.map((line) => line.name) ?? null
    })
    // Ended like any agent the host had to stop: the chat's turn settles and its next message
    // starts the agent again, reopening the session (with catch-up) as today.
    if (relayed.child.exited === null) {
      await relayed.managed.close().catch(() => undefined)
    }
    return refuse(new Error('agent_kept_running_unrestorable'))
  }
  // This launch's own files (a fresh config folder) go unused: the kept agent reads its first one.
  if (relayed?.reattached) {
    await launch.release?.().catch(() => undefined)
  }
  // The chat closed meanwhile: its agent ends here (during quit, a kept one goes back instead).
  if (relayed && input.abandoned()) {
    void relayed.managed.close().catch(() => undefined)
  }
  // One launched with other MCP servers from Orca (one turned off since) lacks this launch's tools.
  const stale =
    appBound ||
    (relayed?.reattached === true &&
      acpKeptToolsDiffer(relayed.child.attachResult?.launchNote, launch.toolsKey))
  return relayed && { ...relayed, turns, ...(stale ? { freshOwed: true as const } : {}) }
}
