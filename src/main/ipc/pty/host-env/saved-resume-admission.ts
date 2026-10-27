import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  normalizeAgentProviderSession,
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type {
  AgentStatusIpcPayload,
  RefusedPaneResume
} from '../../../../shared/agent-status-types'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session-record-store'
import {
  agentSessionLeasePossiblyWriting,
  listStructuredProviderSessionOwnership
} from '../../../native-chat/agent-session-wire/structured-provider-session-ownership'
import { agentHookServer } from '../../../agent-hooks/server'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import {
  keysMayMatch,
  terminalConversationKey
} from '../../../native-chat/structured-conversation-key'

export type ResumeSpawnArgs = {
  connectionId?: string | null
  command?: string
  launchAgent?: TuiAgent
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: unknown
  resumeProviderSession?: AgentProviderSessionMetadata
  /** `saved`: the resume was built from a pane's saved facts, not asked for by the user. */
  resumeOrigin?: unknown
  env?: Record<string, string>
}

type AdmissionRuntime = {
  getAgentProviderSessionRows?(): AgentStatusIpcPayload[]
  readSavedResumeSource?(
    worktreeId: string,
    paneKey: string
  ): Promise<SleepingAgentSessionRecord | undefined>
  openAgentSessionRecordStore(): Promise<AgentSessionRecordStore>
}

/** `chat-home`: an automatic restore of a conversation an open chat continues; `chat-writing`:
 *  any start of one a chat may be writing; `unverifiable`: an automatic restore with no records. */
export type ResumeSpawnRefusal = {
  sourceRecord?: SleepingAgentSessionRecord
  verdict: 'chat-home' | 'chat-writing' | 'unverifiable'
  refused: RefusedPaneResume
}

export type ResumeSpawnAdmission =
  | { verdict: 'admitted'; refused: RefusedPaneResume; sourceRecord?: SleepingAgentSessionRecord }
  | ResumeSpawnRefusal

/** Saved-home policy only; ordinary terminal starts remain hook-observed. */
export async function admitResumeSpawn(
  runtime: AdmissionRuntime | undefined,
  args: ResumeSpawnArgs,
  wslDistro: string | null
): Promise<ResumeSpawnAdmission | null> {
  const providerSession = normalizeAgentProviderSession(args.resumeProviderSession)
  const agent = args.launchAgent
  // Native chats run only natively, so a remote or WSL conversation is never a chat's.
  if (
    args.resumeOrigin !== 'saved' ||
    !providerSession ||
    !agent ||
    args.connectionId ||
    wslDistro !== null
  ) {
    return null
  }
  if (!runtime) {
    return { verdict: 'unverifiable', refused: { agent, providerSession } }
  }
  return judgeResumes(runtime, [{ agent, providerSession }])
}

/** A reattach that found its session gone returns a fresh shell its window then resumes from the
 *  pane's saved facts; this decides that resume before the window can deliver it. */
export async function admitColdRestoreReattach(
  runtime:
    | (AdmissionRuntime & { getAgentProviderSessionRows(): AgentStatusIpcPayload[] })
    | undefined,
  result: { coldRestore?: unknown; isReattach?: boolean },
  pane: { paneKey: string | null; saved: SleepingAgentSessionRecord | undefined },
  wslDistro: string | null
): Promise<ResumeSpawnAdmission | null> {
  const { paneKey, saved } = pane
  if (!runtime || !result.coldRestore || result.isReattach || !paneKey || wslDistro !== null) {
    return null
  }
  const resumes = [
    ...runtime
      .getAgentProviderSessionRows()
      .flatMap((row) =>
        row.paneKey === paneKey &&
        row.state !== 'done' &&
        !row.structuredHost &&
        !row.connectionId &&
        row.agentType &&
        row.providerSession
          ? [{ agent: row.agentType, providerSession: row.providerSession }]
          : []
      ),
    ...(saved && !saved.connectionId
      ? [{ agent: saved.agent, providerSession: saved.providerSession }]
      : [])
  ]
  const [first] = resumes
  return first ? judgeResumes(runtime, [first]) : null
}

async function judgeResumes(
  runtime: AdmissionRuntime,
  resumes: readonly [RefusedPaneResume, ...RefusedPaneResume[]]
): Promise<ResumeSpawnAdmission> {
  const keysOf = ({ agent, providerSession }: RefusedPaneResume) =>
    [providerSession.id, providerSession.transcriptPath].flatMap((id) =>
      id?.trim() ? [terminalConversationKey(agent, id)] : []
    )
  const admitted = (): ResumeSpawnAdmission => ({
    verdict: 'admitted',
    refused: resumes[0]
  })
  let store: AgentSessionRecordStore
  try {
    store = await runtime.openAgentSessionRecordStore()
  } catch (error) {
    console.warn(
      "[pty] native chat records unreadable; cannot tell whether a resume is a chat's",
      error
    )
    return { verdict: 'unverifiable', refused: resumes[0] }
  }
  const heads = listStructuredProviderSessionOwnership(store.listConversations()).filter(
    (holding) => holding.role === 'head'
  )
  const tabs = store.getVisibleSessionTabIndex()
  for (const refused of resumes) {
    const holders = heads.filter((holding) =>
      keysOf(refused).some((key) => keysMayMatch(holding.key, key))
    )
    if (holders.some((holding) => agentSessionLeasePossiblyWriting(holding.ownerObservation))) {
      return { verdict: 'chat-writing', refused }
    }
    if (holders.length > 0 && (!tabs || !tabs.present)) {
      return { verdict: 'unverifiable', refused }
    }
    if (tabs && holders.some((holding) => tabs.sessionIds.includes(holding.sessionId))) {
      return { verdict: 'chat-home', refused }
    }
  }
  return admitted()
}

/** A refused resume becomes the pane's plain shell: nothing of the agent launch is left to run,
 *  register, or mark the shell as an unattended agent's. */
export function dropAgentLaunch(args: ResumeSpawnArgs): void {
  const agentEnv = args.launchConfig?.agentEnv ?? {}
  if (args.env) {
    args.env = Object.fromEntries(
      Object.entries(args.env).filter(
        ([key, value]) =>
          key !== 'ORCA_AGENT_LAUNCH_TOKEN' &&
          key !== 'ORCA_SEQUENCED_STARTUP_COMMAND' &&
          key !== 'ORCA_SEQUENCED_STARTUP_SCRIPT' &&
          agentEnv[key] !== value
      )
    )
  }
  delete args.command
  delete args.launchAgent
  delete args.launchConfig
  delete args.launchToken
  delete args.resumeProviderSession
}

export function resumeSpawnRefusal(
  admission: ResumeSpawnAdmission | null
): ResumeSpawnRefusal | null {
  return admission && admission.verdict !== 'admitted' ? admission : null
}

/** Unwinds only the claim whose fresh callback has issued no physical work. */
export class SavedResumeFreshRefusal extends Error {
  constructor(readonly admission: ResumeSpawnRefusal) {
    super('saved_resume_fresh_refused')
  }
}

/** Called only after a refused plain shell exists; uncertain evidence retains its recipe. */
export function forgetRefusedResume(
  paneKey: string | null,
  refusal: ResumeSpawnRefusal | null
): void {
  if (!paneKey || !refusal || refusal.verdict === 'unverifiable') {
    return
  }
  try {
    agentHookServer.forgetRefusedPaneResume(paneKey, refusal.refused)
  } catch (error) {
    // The shell still starts, and the next restore refuses and retries the cleanup.
    console.warn('[pty] could not forget a resume a native chat holds', error)
  }
}

/** The pane's saved resume on this host, which its window resumes from after a cold restore. */
export function savedResumeRecord(
  store:
    | { getWorkspaceSession?(hostId: ExecutionHostId): WorkspaceSessionState | undefined }
    | undefined,
  paneKey: string | null
): SleepingAgentSessionRecord | undefined {
  return paneKey
    ? store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)?.sleepingAgentSessionsByPaneKey?.[
        paneKey
      ]
    : undefined
}

/** Runs only in the fresh branch, after stable/claimed owner adoption has settled. */
export async function chooseSavedResumeFreshLaunch(
  runtime: AdmissionRuntime | undefined,
  args: ResumeSpawnArgs,
  wslDistro: string | null,
  options: ResumeSpawnArgs & { startupCommandDelivery?: unknown; startupIngress?: unknown }
): Promise<ResumeSpawnAdmission | null> {
  const admission = await admitResumeSpawn(runtime, args, wslDistro)
  if (resumeSpawnRefusal(admission)) {
    suppressSavedResumeLaunch(args, options)
  }
  return admission
}

/** A claim joiner uses the same suppression without reclassifying the settled request. */
export function suppressSavedResumeLaunch(
  args: ResumeSpawnArgs,
  options: ResumeSpawnArgs & { startupCommandDelivery?: unknown; startupIngress?: unknown }
): void {
  options.launchConfig = args.launchConfig
  dropAgentLaunch(options)
  delete options.startupCommandDelivery
  delete options.startupIngress
  dropAgentLaunch(args)
}

export function savedResumeResult(admission: ResumeSpawnAdmission | null) {
  if (!admission) {
    return {}
  }
  const { agent, providerSession } = admission.refused
  return {
    savedResumeDecision: { agent, providerSession, verdict: admission.verdict },
    ...(admission.verdict !== 'admitted'
      ? {
          agentResumeRefused: admission.verdict,
          agentResumeUnavailable: true as const,
          refusedResume: admission.refused
        }
      : {})
  }
}

/** Capture before spawn; later same-conversation status and saved versions belong to later work. */
export async function captureSavedResumeCleanup(
  runtime: AdmissionRuntime | undefined,
  store: Parameters<typeof savedResumeRecord>[0],
  paneKey: string | null,
  admission: ResumeSpawnAdmission | null,
  worktreeId?: string
): Promise<void> {
  if (!paneKey || !admission) {
    return
  }
  let candidate = savedResumeRecord(store, paneKey)
  if (runtime?.readSavedResumeSource && worktreeId) {
    try {
      candidate = await runtime.readSavedResumeSource(worktreeId, paneKey)
    } catch (error) {
      console.warn('[pty] could not capture saved resume cleanup source', error)
    }
  }
  const saved =
    candidate &&
    candidate.agent === admission.refused.agent &&
    agentProviderSessionsEqual(
      candidate.agent,
      candidate.providerSession,
      admission.refused.providerSession
    )
      ? candidate
      : undefined
  const row = runtime
    ?.getAgentProviderSessionRows?.()
    .find(
      (entry) =>
        entry.paneKey === paneKey &&
        entry.agentType === admission.refused.agent &&
        agentProviderSessionsEqual(
          entry.agentType,
          entry.providerSession,
          admission.refused.providerSession
        )
    )
  admission.sourceRecord = saved
  admission.refused = {
    ...admission.refused,
    ...(row
      ? {
          expectedStatus: {
            paneKey,
            receivedAt: row.receivedAt,
            stateStartedAt: row.stateStartedAt
          }
        }
      : {}),
    ...(saved
      ? {
          expectedSavedRecord: {
            paneKey,
            capturedAt: saved.capturedAt,
            updatedAt: saved.updatedAt
          }
        }
      : {})
  }
}
