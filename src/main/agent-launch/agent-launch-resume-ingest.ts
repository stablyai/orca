// Host ingestion for the provider-session resume/fork variant (U5). A resume
// request names only the session ownership key; this module loads the host-private
// record and produces the resume-specific launch inputs the shared spawn pipeline
// consumes. A v1-snapshot record replays through resolveAgentLaunch's snapshot
// path (structured argv); a one-release legacy record replays OPAQUELY through
// agent-launch-legacy-replay (pre-quoted command), which bypasses the resolver.
//
// Precedence per plan §575: a present valid v1 snapshot replays; else a present
// valid + eligible legacy config replays (desktop/host-initiated only); else a
// record with neither field, or no record at all, returns in-band
// `invalid_launch_snapshot` (a persisted launch-attempt failure, NOT a request
// error) so the client offers "Launch with current settings" rather than silently
// substituting current config. A present-but-invalid value fails the same way and
// leaves the source record unchanged (never a partial write).

import type { AgentLaunchSnapshot, LaunchIntent } from '../../shared/agent-launch-host-contract'
import type {
  AgentLaunchResumeRequest,
  AgentLaunchSpawnRequest
} from '../../shared/agent-launch-spawn-request'
import type { TuiAgent } from '../../shared/types'
import {
  providerSessionKeyForResumableBase,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import { buildLegacyResumeReplay } from './agent-launch-legacy-replay'
import type { AgentSessionRecordStore } from './agent-session-record-store'

/** Client kind for the resume intent, mapped host-side from the authenticated
 *  scope — never copied from client payload. */
export type ResumeLaunchClient = 'desktop' | 'paired-web' | 'mobile'

export type ResumeLaunchIngestInput = {
  resume: AgentLaunchResumeRequest['resume']
  client: ResumeLaunchClient
  /** Trusted desktop-only opaque legacy replay context. Present only on the
   *  in-process pty:spawn surface; absent on runtime/mobile/paired RPC, so a
   *  legacy record there resolves to invalid_launch_snapshot per the migration
   *  rules (opaque replay is desktop/host-initiated only). */
  legacy?: {
    shell: AgentStartupShell
    /** Current spawn's execution owner, for legacy provenance. */
    connectionId: string | null
    /** The pre-quoted config the renderer surrenders over trusted IPC on first
     *  resume of a pre-U5 session; absent once the host owns the record. */
    handoff?: {
      launchConfig: SleepingAgentLaunchConfig
      recordedConnectionId: string | null
      /** The sleeping record's transcript path. The ownership key carries only
       *  the provider session id, but Pi/Prime-Agent resume by transcript path,
       *  so without it a pre-U5 sleeping session of those bases can never
       *  resume (its resume argv is null → invalid_launch_snapshot). Trusted at
       *  the same level as the opaque command it accompanies: desktop IPC only. */
      transcriptPath?: string
    }
  }
}

/** A v1-snapshot resume: merged with host-context target/variables/scope/principal
 *  into an AgentLaunchSpawnInput and resolved through the snapshot replay path. */
export type ResumeSnapshotIngest = {
  ok: true
  kind: 'snapshot'
  request: AgentLaunchSpawnRequest
  intent: LaunchIntent
  persistedSnapshot: AgentLaunchSnapshot
  resumeProviderSession: AgentProviderSessionMetadata
}

/** An opaque legacy resume: the launchCommand/launchConfig feed the pre-U5 spawn
 *  fields directly, bypassing the resolver (no admission token/receipt). */
export type ResumeLegacyIngest = {
  ok: true
  kind: 'legacy'
  intent: LaunchIntent
  requestedAgent: TuiAgent
  baseAgent: ResumableTuiAgent
  launchCommand: string
  launchConfig: SleepingAgentLaunchConfig
}

export type ResumeLaunchIngestResult =
  | ResumeSnapshotIngest
  | ResumeLegacyIngest
  | { ok: false; failure: { code: 'invalid_launch_snapshot' } }

const INVALID = { ok: false, failure: { code: 'invalid_launch_snapshot' } } as const

/** Resolve a resume/fork request against the private record store. */
export function resolveResumeLaunchIngest(
  input: ResumeLaunchIngestInput,
  store: AgentSessionRecordStore
): ResumeLaunchIngestResult {
  const intent: LaunchIntent = {
    kind: 'resume',
    operation: input.resume.operation,
    client: input.client
  }
  const record = store.resolveByOwnershipKey(input.resume.sessionKey)

  if (record?.launchSnapshot) {
    // The record's requested identity resolves the same base the snapshot pins;
    // the resolver's replay path re-checks the snapshot/identity match. `session`
    // marks the reference authority so a live picker cannot forge it.
    return {
      ok: true,
      kind: 'snapshot',
      request: {
        selection: { kind: 'agent', agent: record.requestedAgent },
        // Resume launches a bare TUI (no client prompt); the provider resume flags
        // come from the snapshot replay, not a prompt.
        allowEmptyPromptLaunch: true,
        sourceRecord: { owner: 'session' }
      },
      intent,
      persistedSnapshot: record.launchSnapshot,
      resumeProviderSession: record.providerSession
    }
  }

  // Opaque legacy replay is desktop/host-initiated only; the trusted context is
  // absent on every untrusted surface, so those legacy resumes fail closed.
  if (input.legacy && input.client === 'desktop') {
    if (record?.legacyLaunchConfig) {
      // Host already owns the config: re-validate provenance and replay from it.
      const replay = buildLegacyResumeReplay({
        legacyLaunchConfig: record.legacyLaunchConfig,
        requestedAgent: record.requestedAgent,
        baseAgent: record.baseAgent,
        providerSession: record.providerSession,
        shell: input.legacy.shell,
        recordedConnectionId: record.legacyConnectionId ?? null,
        currentConnectionId: input.legacy.connectionId
      })
      return replay.ok ? { ok: true, kind: 'legacy', intent, ...replayFields(replay) } : INVALID
    }
    if (!record && input.legacy.handoff) {
      // First resume of a pre-U5 session: the renderer surrenders the config.
      // A legacy record's requested identity equals its base (migration rule).
      const baseAgent = input.resume.sessionKey.baseAgent
      const handoffTranscriptPath = input.legacy.handoff.transcriptPath?.trim()
      const providerSession: AgentProviderSessionMetadata = {
        key: providerSessionKeyForResumableBase(baseAgent),
        id: input.resume.sessionKey.providerSessionId,
        // Pi/Prime-Agent resume by this path, never by id; the ownership key
        // cannot carry it, so it rides the one-time legacy handoff and is then
        // owned by the persisted record for every later resume.
        ...(handoffTranscriptPath ? { transcriptPath: handoffTranscriptPath } : {})
      }
      const replay = buildLegacyResumeReplay({
        legacyLaunchConfig: input.legacy.handoff.launchConfig,
        requestedAgent: baseAgent,
        baseAgent,
        providerSession,
        shell: input.legacy.shell,
        recordedConnectionId: input.legacy.handoff.recordedConnectionId,
        currentConnectionId: input.legacy.connectionId
      })
      if (!replay.ok) {
        // Validation failed: leave the store untouched (never a partial write).
        return INVALID
      }
      // Persist-once: the host owns the config thereafter, so a later resume works
      // without the renderer re-sending it (the client field is deleted next
      // release). Persist the replay's cleaned durable config (trimmed, env
      // stripped of attribution/teams keys), never the raw client handoff.
      store.ingestLegacyRecord({
        ownershipKey: input.resume.sessionKey,
        requestedAgent: baseAgent,
        providerSession,
        legacyLaunchConfig: replay.launchConfig,
        connectionId: input.legacy.handoff.recordedConnectionId
      })
      return { ok: true, kind: 'legacy', intent, ...replayFields(replay) }
    }
  }

  // No record, a record without a replayable field, or a legacy record reached
  // over an untrusted surface: never silently resolve current config. Log which
  // (identity only) — the client renders one generic code for all of them.
  console.warn(
    `[agent-launch] resume ingest rejected base=${input.resume.sessionKey.baseAgent} ` +
      `record=${record ? 'unreplayable' : 'none'} client=${input.client} ` +
      `legacyContext=${input.legacy ? (input.legacy.handoff ? 'handoff' : 'no-handoff') : 'absent'}`
  )
  return INVALID
}

function replayFields(
  replay: Extract<ReturnType<typeof buildLegacyResumeReplay>, { ok: true }>
): Pick<ResumeLegacyIngest, 'requestedAgent' | 'baseAgent' | 'launchCommand' | 'launchConfig'> {
  return {
    requestedAgent: replay.requestedAgent,
    baseAgent: replay.baseAgent,
    launchCommand: replay.launchCommand,
    launchConfig: replay.launchConfig
  }
}
