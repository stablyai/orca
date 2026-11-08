// Derives protected milestones from already-validated, consented product events so sampling and the shared budget cannot hide them.
// Not exactly-once: cursors advance at SDK enqueue/hold acceptance (a quit before flush loses the event) and persist via the
// debounced settings save (a crash before that save can re-emit after restart), so dashboards dedupe per install_id.

import type { GlobalSettings } from '../../shared/global-settings-types'
import { utcDayIndex } from '../../shared/telemetry-day'
import { eventSchemas, type EventName, type EventProps } from '../../shared/telemetry-events'
import type {
  FirstAgentInteractionSource,
  MeaningfulActivityTrigger
} from '../../shared/telemetry-protected-milestone-schemas'
import type { TelemetrySettings } from '../../shared/telemetry-settings-types'
import type { Store } from '../persistence/loading-store/store'
import { consumeBurstToken } from './burst-cap'
import { validate } from './validator'

export type ProtectedMilestone =
  | { name: 'first_agent_interaction'; props: EventProps<'first_agent_interaction'> }
  | { name: 'meaningful_activity_day'; props: EventProps<'meaningful_activity_day'> }

type ProtectedMilestoneCursor = { firstInteractionDone: boolean; activityDay: number }
type Observation = EventName | 'terminal_input'
type SourceObservation =
  | { name: 'agent_started'; props: EventProps<'agent_started'> }
  | { name: 'agent_prompt_sent'; props: EventProps<'agent_prompt_sent'> }
  | { name: 'native_chat_prompt_submitted'; props: EventProps<'native_chat_prompt_submitted'> }
  | { name: 'workspace_created'; props: EventProps<'workspace_created'> }
  | { name: 'terminal_input' }
type Enqueue = (name: ProtectedMilestone['name'], props: ProtectedMilestone['props']) => void
type MilestoneSession = { store: Store; enqueue: Enqueue; isEnabled: () => boolean }

const SOURCE_EVENTS: ReadonlySet<string> = new Set<EventName>([
  'agent_started',
  'agent_prompt_sent',
  'native_chat_prompt_submitted',
  'workspace_created'
])
// Automation and scriptable launches cannot prove a person acted that day.
const UNATTRIBUTED_LAUNCH_SOURCES: ReadonlySet<string> = new Set([
  'orchestration',
  'cli',
  'unknown'
])

// While a UTC day is unmarked, typing must cost at most one consent read a minute within that day.
const TERMINAL_INPUT_CHECK_INTERVAL_MS = 60_000

// Mirrors accepted cursors so a failed settings write cannot re-emit within the session.
let cursor: ProtectedMilestoneCursor | null = null
let session: MilestoneSession | null = null
let lastTerminalInputCheckAt: number | null = null

/** Bind the telemetry session's store, capture path and live gates; each launch starts from persisted cursors. */
export function bindSession(store: Store, enqueue: Enqueue, isEnabled: () => boolean): void {
  session = { store, enqueue, isEnabled }
  cursor = null
  lastTerminalInputCheckAt = null
}

/** Cheap pre-check before consent reads: the UTC day an observation could still earn a milestone for, else null. */
export function observationDay(name: EventName, now = Date.now()): number | null {
  if (!SOURCE_EVENTS.has(name)) {
    return null
  }
  const day = utcDayIndex(now)
  // An unknown cursor defers to the persisted one.
  if (!cursor || cursor.activityDay < day) {
    return day
  }
  const canStillInteract =
    !cursor.firstInteractionDone && name !== 'agent_started' && name !== 'workspace_created'
  return canStillInteract ? day : null
}

// Re-parse with the source schema so eligibility reads typed fields; only runs while a milestone is unearned.
function parseObservation(name: Observation, props: unknown): SourceObservation | null {
  if (name === 'terminal_input') {
    return { name }
  }
  if (name === 'agent_started') {
    const parsed = eventSchemas.agent_started.safeParse(props)
    return parsed.success ? { name, props: parsed.data } : null
  }
  if (name === 'agent_prompt_sent') {
    const parsed = eventSchemas.agent_prompt_sent.safeParse(props)
    return parsed.success ? { name, props: parsed.data } : null
  }
  if (name === 'native_chat_prompt_submitted') {
    const parsed = eventSchemas.native_chat_prompt_submitted.safeParse(props)
    return parsed.success ? { name, props: parsed.data } : null
  }
  if (name === 'workspace_created') {
    const parsed = eventSchemas.workspace_created.safeParse(props)
    return parsed.success ? { name, props: parsed.data } : null
  }
  return null
}

function interactionSource(observation: SourceObservation): FirstAgentInteractionSource | null {
  if (observation.name === 'native_chat_prompt_submitted') {
    return observation.props.client === 'mobile' ? 'mobile_chat' : 'native_chat'
  }
  if (observation.name === 'agent_prompt_sent') {
    return UNATTRIBUTED_LAUNCH_SOURCES.has(observation.props.launch_source)
      ? 'unattributed_prompt'
      : 'orca_send'
  }
  return null
}

function activityTrigger(observation: SourceObservation): MeaningfulActivityTrigger | null {
  if (observation.name === 'terminal_input') {
    return 'terminal_input'
  }
  if (observation.name === 'agent_started') {
    // Resumes include background wakes of sleeping sessions.
    return observation.props.request_kind === 'new' &&
      !UNATTRIBUTED_LAUNCH_SOURCES.has(observation.props.launch_source)
      ? 'agent_started'
      : null
  }
  if (observation.name === 'workspace_created') {
    return observation.props.source === 'unknown' ? null : 'workspace_created'
  }
  const source = interactionSource(observation)
  return source === 'unattributed_prompt' ? null : source
}

function hydrate(saved: TelemetrySettings['protectedMilestones']): ProtectedMilestoneCursor {
  const persisted = {
    firstInteractionDone: saved?.firstAgentInteractionDay !== undefined,
    activityDay: saved?.meaningfulActivityDay ?? -1
  }
  cursor = {
    firstInteractionDone: persisted.firstInteractionDone || cursor?.firstInteractionDone === true,
    activityDay: Math.max(persisted.activityDay, cursor?.activityDay ?? -1)
  }
  return cursor
}

/** Milestones a validated, consented observation earns. */
function earnedProtectedMilestones(
  name: Observation,
  props: unknown,
  telemetry: TelemetrySettings | undefined,
  day: number
): ProtectedMilestone[] {
  const observation = parseObservation(name, props)
  if (!observation) {
    return []
  }
  const current = hydrate(telemetry?.protectedMilestones)
  // Unknown provenance must not claim a fresh install.
  const install_cohort = telemetry?.protectedMilestones?.installCohort ?? 'existing'
  const earned: ProtectedMilestone[] = []
  const source = interactionSource(observation)
  if (
    source &&
    (observation.name === 'agent_prompt_sent' ||
      observation.name === 'native_chat_prompt_submitted') &&
    !current.firstInteractionDone
  ) {
    earned.push({
      name: 'first_agent_interaction',
      props: { source, agent_kind: observation.props.agent_kind, install_cohort }
    })
  }
  const trigger = activityTrigger(observation)
  if (trigger && current.activityDay < day) {
    earned.push({ name: 'meaningful_activity_day', props: { trigger, install_cohort } })
  }
  return earned
}

/** Advance the cursor for an accepted capture and return the settings value to persist. */
function acceptProtectedMilestone(
  milestone: ProtectedMilestone['name'],
  telemetry: TelemetrySettings | undefined,
  day: number
): NonNullable<TelemetrySettings['protectedMilestones']> {
  const current = hydrate(telemetry?.protectedMilestones)
  const saved = telemetry?.protectedMilestones ?? {}
  if (milestone === 'first_agent_interaction') {
    current.firstInteractionDone = true
    return { ...saved, firstAgentInteractionDay: saved.firstAgentInteractionDay ?? day }
  }
  current.activityDay = Math.max(current.activityDay, day)
  return { ...saved, meaningfulActivityDay: current.activityDay }
}

/** Persist each cursor only after its capture is enqueued or held, so rejected attempts retry on the next observation. */
export function record(
  name: Observation,
  props: unknown,
  settings: GlobalSettings,
  day: number
): void {
  if (!session) {
    return
  }
  const { store, enqueue } = session
  for (const milestone of earnedProtectedMilestones(name, props, settings.telemetry, day)) {
    if (!consumeBurstToken(milestone.name)) {
      continue
    }
    const validated = validate(milestone.name, milestone.props)
    if (!validated.ok) {
      continue
    }
    try {
      enqueue(milestone.name, validated.props)
    } catch (err) {
      console.warn('[telemetry] protected milestone capture failed', err)
      continue
    }
    const telemetry = store.getSettings().telemetry
    const protectedMilestones = acceptProtectedMilestone(milestone.name, telemetry, day)
    if (!telemetry) {
      continue
    }
    try {
      store.updateSettings({ telemetry: { ...telemetry, protectedMilestones } })
    } catch (err) {
      console.warn('[telemetry] failed to persist protected milestone cursor', err)
    }
  }
}

/** Genuine desktop xterm input admitted by a local or remote transport marks the day. */
export function observeTerminalUserInput(now = Date.now()): void {
  const day = utcDayIndex(now)
  if (!session || (cursor && cursor.activityDay >= day)) {
    return
  }
  const last = lastTerminalInputCheckAt
  if (
    last !== null &&
    utcDayIndex(last) === day &&
    now >= last &&
    now - last < TERMINAL_INPUT_CHECK_INTERVAL_MS
  ) {
    return
  }
  try {
    if (!session.isEnabled()) {
      lastTerminalInputCheckAt = now
      return
    }
    const settings = session.store.getSettings()
    if (hydrate(settings.telemetry?.protectedMilestones).activityDay >= day) {
      return
    }
    lastTerminalInputCheckAt = now
    record('terminal_input', undefined, settings, day)
  } catch (err) {
    lastTerminalInputCheckAt = now
    // Telemetry must never disturb terminal input.
    console.warn('[telemetry] terminal activity milestone failed', err)
  }
}
