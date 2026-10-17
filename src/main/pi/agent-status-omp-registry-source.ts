import {
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH,
  AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH,
  AGENT_STATUS_TOOL_NAME_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH
} from '../../shared/agent-status-types'

// The extension runs inside the host SDK: its exported registry is the only
// source of native identity. Never import a second SDK or inspect transcripts.
export function getOmpRegistrySnapshotSourceLines(): string[] {
  return [
    `const OMP_STATUS_TEXT_LIMIT = ${AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH}`,
    `const OMP_STATUS_INPUT_LIMIT = ${AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH}`,
    `const OMP_STATUS_TOOL_LIMIT = ${AGENT_STATUS_TOOL_NAME_MAX_LENGTH}`,
    `const OMP_STATUS_ROLE_LIMIT = ${AGENT_TYPE_MAX_LENGTH}`,
    ...String.raw`
type OmpRootStatus = { state: 'working' | 'blocked' | 'waiting' | 'done'; prompt?: string; tool_name?: string; tool_input?: unknown; role?: 'assistant'; text?: string; session_boundary?: true; input_pending?: boolean }
type OmpNativeManager = { getSessionId?: () => unknown; getSessionFile?: () => unknown }
type OmpNativeSession = { sessionManager?: OmpNativeManager; isStreaming?: boolean; hasPendingAsyncWork?: () => boolean }
type OmpNativeRef = { id: string; displayName?: string; kind: string; parentId?: string; status: string; session?: OmpNativeSession | null; sessionFile?: string | null; createdAt?: number; history?: { agent?: string }; lifecycle?: { acceptedAt?: number; terminalAt?: number } }
type OmpNativeRegistry = { list: () => OmpNativeRef[]; get: (id: string) => OmpNativeRef | undefined; onChange: (handler: (event: { type?: string; ref?: OmpNativeRef }) => void) => (() => void); isRunning?: (ref: OmpNativeRef) => boolean }
type OmpRegistryApi = { pi?: { MAIN_AGENT_ID?: unknown; AgentRegistry?: { global?: () => unknown } } }
type OmpRegistryContext = { agent?: { id?: unknown; kind?: unknown }; agentKind?: unknown; sessionManager?: OmpNativeManager }
type OmpRootEvent = { prompt?: unknown; toolName?: unknown; input?: unknown; args?: unknown; reason?: unknown; message?: { role?: unknown; content?: unknown }; willContinue?: boolean }
type OmpRegistryObservation = { owner: object; roster: SubagentRoster; registry: OmpNativeRegistry; root: OmpNativeRef; manager: OmpNativeManager; sessionId: string; sessionFile: string; status: OmpRootStatus; identityBoundaryPending: boolean; approvalPending: boolean; approvalDetails?: { tool_name?: string; tool_input?: string }; questionToolName?: string; subscribed: boolean; stopped: boolean; verified: boolean; pending: boolean; readUnavailable: boolean; rootExecuting: boolean; rootBaselinePending: boolean; dirty: boolean; unsubscribe?: () => void; changeTimer: NodeJS.Timeout | null; refreshTimer: NodeJS.Timeout | null }
let ompRegistryObservation: OmpRegistryObservation | null = null

function isOmpNativeSessionExecuting(session: OmpNativeSession | null | undefined): boolean {
  return session?.isStreaming === true || (typeof session?.hasPendingAsyncWork === 'function' && session.hasPendingAsyncWork() === true)
}

function isOmpNativeRegistry(registry: unknown): registry is OmpNativeRegistry {
  return typeof registry === 'object' && registry !== null &&
    'list' in registry && typeof registry.list === 'function' &&
    'get' in registry && typeof registry.get === 'function' &&
    'onChange' in registry && typeof registry.onChange === 'function'
}

function getOmpNativeRegistry(api: OmpRegistryApi): OmpNativeRegistry | null {
  if (!isOmpRuntime()) return null
  try {
    const Registry = api?.pi?.AgentRegistry
    if (typeof Registry?.global !== 'function') return null
    const registry = Registry.global()
    return isOmpNativeRegistry(registry) ? registry : null
  } catch { return null }
}

function getOmpRegistryRootRef(api: OmpRegistryApi, registry: OmpNativeRegistry, ctx: OmpRegistryContext): OmpNativeRef | null {
  if (!isOmpRuntime() || !ctx?.sessionManager) return null
  const kind = ctx.agent?.kind ?? ctx.agentKind
  if (kind !== undefined && kind !== 'main') return null
  const id = ctx.agent?.id ?? api?.pi?.MAIN_AGENT_ID
  if (typeof id !== 'string' || !id) return null
  try {
    const ref = registry.get(id)
    return ref?.kind === 'main' && ref.session?.sessionManager === ctx.sessionManager ? ref : null
  } catch { return null }
}

function isOmpRegistryObserved(): boolean {
  const observation = ompRegistryObservation
  return isOmpRuntime() && !!observation && observation.subscribed && !observation.stopped && observation.roster === subagentRoster
}

// Unknown native membership holds completion but is never published as fresh evidence.
function isOmpRegistryPending(): boolean {
  return isOmpRegistryObserved() && ompRegistryObservation?.pending === true
}

// Failed enumeration and positively obsolete ownership cannot renew cached proof.
// Ordinary 200ms coalescing alone does not invalidate the last verified read.
function isOmpRegistryReadUnavailable(): boolean {
  return isOmpRuntime() && (subagentRoster?.ownsPane === false || (isOmpRegistryObserved() && ompRegistryObservation?.readUnavailable === true))
}

function ompRegistrySnapshotMetadata(hookEventName?: string): Record<string, unknown> {
  const observation = ompRegistryObservation
  if (hookEventName !== 'subagents_update' || !isOmpRegistryObserved() || !observation?.verified) return {}
  return { omp_status: { ...observation.status, ...(observation.identityBoundaryPending ? { session_boundary: true } : {}) } }
}

// A turn can start before the coalesced first snapshot reaches Orca. Keep the
// separate identity proof until that identity's authoritative snapshot is delivered.
function acknowledgeOmpRegistrySnapshot(metadata: Record<string, unknown>): void {
  const observation = ompRegistryObservation
  if (!isOmpRegistryObserved() || !observation || observation.roster.ownsPane !== true || observation.roster.ompRegistryObserver !== observation ||
      typeof metadata.session_id !== 'string' || !metadata.session_id || typeof metadata.session_file !== 'string' || !metadata.session_file ||
      metadata.session_id !== observation.sessionId || metadata.session_file !== observation.sessionFile) return
  try {
    if (observation.registry.get(observation.root.id) !== observation.root || observation.root.session?.sessionManager !== observation.manager ||
        observation.manager.getSessionId?.() !== observation.sessionId || observation.manager.getSessionFile?.() !== observation.sessionFile) return
  } catch { return }
  observation.identityBoundaryPending = false
}

function retireOmpRegistryObservation(observation: OmpRegistryObservation): void {
  observation.stopped = true
  observation.pending = false
  observation.readUnavailable = false
  observation.subscribed = false
  observation.approvalDetails = undefined
  if (observation.changeTimer !== null) clearTimeout(observation.changeTimer)
  if (observation.refreshTimer !== null) clearTimeout(observation.refreshTimer)
  observation.changeTimer = null
  observation.refreshTimer = null
  try { observation.unsubscribe?.() } catch {}
  observation.unsubscribe = undefined
  if (observation.roster.ompRegistryObserver === observation) observation.roster.ompRegistryObserver = undefined
  if (ompRegistryObservation === observation) ompRegistryObservation = null
}
`
      .trim()
      .split('\n'),
    ''
  ]
}
