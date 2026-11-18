import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { agentHookServer } from '../../../agent-hooks/server/agent-hook-server'
// oxfmt-ignore
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import {
  judgeSavedResume,
  type AdmissionRuntime,
  type ResumeSpawnAdmission,
  type ResumeSpawnRefusal
} from './saved-resume-ownership'
export type { ResumeSpawnAdmission, ResumeSpawnRefusal } from './saved-resume-ownership'

export type ResumeSpawnArgs = {
  connectionId?: string | null
  command?: string
  launchAgent?: TuiAgent
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: unknown
  resumeProviderSession?: AgentProviderSessionMetadata
  /** `saved`: the resume was built from a pane's saved facts, not asked for by the user. */
  resumeOrigin?: unknown
  spawnIntent?: unknown
  env?: Record<string, string>
}

/** Only automatic saved resumes yield to an existing conversation owner. */
export async function admitResumeSpawn(
  runtime: AdmissionRuntime | undefined,
  args: ResumeSpawnArgs,
  wslDistro: string | null
): Promise<ResumeSpawnAdmission | null> {
  const providerSession = normalizeAgentProviderSession(args.resumeProviderSession)
  const agent = args.launchAgent
  if (args.resumeOrigin !== 'saved' || !providerSession || !agent) {
    return null
  }
  return judgeSavedResume(
    runtime,
    { agent, providerSession },
    args.connectionId ?? null,
    wslDistro,
    {
      spawnIntent: args.spawnIntent
    }
  )
}

/** A reattach that found its session gone returns a fresh shell its window then resumes from the
 *  pane's saved facts; this decides that resume before the window can deliver it. */
export async function admitColdRestoreReattach(
  runtime:
    | (AdmissionRuntime & { getAgentProviderSessionRows(): AgentStatusIpcPayload[] })
    | undefined,
  result: { id?: string; coldRestore?: unknown; isReattach?: boolean },
  pane: {
    paneKey: string | null
    saved: SleepingAgentSessionRecord | undefined
    connectionId?: string | null
    spawnIntent?: unknown
  },
  wslDistro: string | null
): Promise<ResumeSpawnAdmission | null> {
  const { paneKey, saved } = pane
  if (!runtime || !result.coldRestore || result.isReattach || !paneKey) {
    return null
  }
  const resumes = [
    ...runtime
      .getAgentProviderSessionRows()
      .flatMap((row) =>
        row.paneKey === paneKey &&
        row.state !== 'done' &&
        !row.structuredHost &&
        (row.connectionId ?? null) === (pane.connectionId ?? null) &&
        row.agentType &&
        row.providerSession
          ? [{ agent: row.agentType, providerSession: row.providerSession }]
          : []
      ),
    ...(saved && (saved.connectionId ?? null) === (pane.connectionId ?? null)
      ? [{ agent: saved.agent, providerSession: saved.providerSession }]
      : [])
  ]
  const distinct = resumes.filter(
    (candidate, index) =>
      !resumes
        .slice(0, index)
        .some(
          (previous) =>
            previous.agent === candidate.agent &&
            agentProviderSessionsEqual(
              candidate.agent,
              previous.providerSession,
              candidate.providerSession
            )
        )
  )
  let firstAdmission: ResumeSpawnAdmission | null = null
  for (const [index, candidate] of distinct.entries()) {
    const admission = await judgeSavedResume(
      runtime,
      candidate,
      pane.connectionId ?? null,
      wslDistro,
      {
        restoringPtyId: result.id,
        spawnIntent: pane.spawnIntent
      }
    )
    const refusal = resumeSpawnRefusal(admission)
    if (refusal) {
      return index === 0 ? refusal : { ...refusal, verdict: 'unverifiable' }
    }
    if (index === 0) {
      firstAdmission = admission
    }
  }
  return firstAdmission
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
