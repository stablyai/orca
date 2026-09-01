// Host-side AI Vault resume assembly (U5 FULL PORT of the renderer's
// buildAiVaultResumeStartupForWorktree). The client only echoes a discovered
// entry's identity; the host re-validates it against its OWN fresh discovery and
// rebuilds the resume command here, bypassing the resolver like legacy opaque
// replay (no admission token/receipt). The renderer helper deliberately encodes
// semantics the structured resolver does not model — remote-verbatim resume,
// OMP absolute-transcript resume, and WSL Codex-home rewrite — so this is a
// faithful replication, not a re-derivation.
//
// The only renderer-specific piece dropped in the port is the AppState platform
// heuristic (WSL/workspace probing): the host already knows the spawning target
// platform, and a session may only resume on a target matching its own host, so
// a non-local entry uses the discovered host platform and a local one uses the
// spawning host's platform directly.

import { randomUUID } from 'node:crypto'
import type { AgentLaunchExecutionHostId } from '../../shared/agent-launch-host-contract'
import type { PersistedLaunchNoticeState } from '../../shared/agent-launch-contract'
import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand
} from '../../shared/ai-vault-resume-command'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  isResumableTuiAgent,
  providerSessionKeyForResumableBase,
  type SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { normalizeAiVaultResumeFilePath } from '../../shared/ai-vault-resume-path'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import { aiVaultResumeClearEnvNames } from '../../shared/ai-vault-resume-preparation'
import type { TuiAgent } from '../../shared/types'
import type {
  AgentLaunchResumeRequest,
  AgentLaunchVaultResumeDetailsResult,
  AgentLaunchVaultResumeCopyResult,
  AgentLaunchVaultResumeEntry
} from '../../shared/agent-launch-spawn-request'
import type { AgentSessionRecordStore } from './agent-session-record-store'

/** Re-exported for host callers that assemble the copy result. */
export type VaultResumeCopyResult = AgentLaunchVaultResumeCopyResult
export type VaultResumeDetailsResult = AgentLaunchVaultResumeDetailsResult

/** The fresh discovery slice the assembly reads. Sourced from the host's own
 *  `listAiVaultSessions`, never from the client — the client's echoed identity is
 *  only used to look this up (its `filePath` is ignored and re-derived here). */
export type VaultResumeSession = Pick<
  AiVaultSession,
  'agent' | 'sessionId' | 'cwd' | 'codexHome' | 'executionHostId'
> &
  Partial<
    Pick<AiVaultSession, 'executionHostPlatform' | 'resumeCommand' | 'resumeLocator' | 'filePath'>
  >

/** Host settings the assembly reads. Built-in-keyed records are assignable to the
 *  wider TuiAgent-keyed helper params (all keys optional). */
export type VaultResumeAssemblySettings = {
  agentCmdOverrides?: Partial<Record<TuiAgent, string>>
  agentDefaultArgs?: Partial<Record<TuiAgent, string>>
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>>
  terminalWindowsShell?: string
}

export type VaultResumeStartup = {
  command: string
  env?: Record<string, string>
  /** Names the spawned pane must UNSET. A Codex session repinned to the real
   *  home inherits CODEX_HOME from the Orca process otherwise. */
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
}

/** Re-validate the client-echoed entry against the host's OWN fresh discovery.
 *  New entries match their opaque locator exactly. Legacy entries without one
 *  are accepted only when the three-field identity has one fresh match. */
export function findVaultResumeSession<S extends VaultResumeSession>(
  entry: AgentLaunchVaultResumeEntry,
  sessions: readonly S[]
): S | null {
  const identityMatches = sessions.filter(
    (session) =>
      session.executionHostId === entry.executionHostId &&
      session.agent === entry.agent &&
      session.sessionId === entry.sessionId
  )
  const matches = entry.resumeLocator
    ? identityMatches.filter((session) => session.resumeLocator === entry.resumeLocator)
    : identityMatches
  return matches.length === 1 ? matches[0] : null
}

/** Re-validate + assemble the copyable resume command for a client-echoed entry.
 *  Shared by the desktop IPC and runtime RPC copy surfaces; the caller supplies
 *  its own fresh discovery and the spawning host platform. */
export function resolveVaultResumeCopyCommand(args: {
  entry: AgentLaunchVaultResumeEntry
  sessions: readonly VaultResumeSession[]
  hostPlatform: NodeJS.Platform
  settings?: VaultResumeAssemblySettings
}): VaultResumeCopyResult {
  const session = findVaultResumeSession(args.entry, args.sessions)
  if (!session) {
    return { status: 'failed', failure: { code: 'invalid_launch_snapshot' } }
  }
  return {
    status: 'ok',
    command: buildVaultResumeStartup({
      session,
      hostPlatform: args.hostPlatform,
      settings: args.settings,
      forCopy: true
    }).command
  }
}

export type VaultResumeSpawnResult =
  | { status: 'ok'; startup: VaultResumeStartup }
  | { status: 'failed'; failure: { code: 'invalid_launch_snapshot' } }

/** Re-validate + assemble a vault resume SPAWN (as distinct from copy). A `copy`
 *  operation is served by the dedicated command method, so reaching here is a
 *  misroute; an entry the fresh scan does not contain fails closed. Both failures
 *  are invalid_launch_snapshot — no terminal, no client path becomes a spawn input. */
export function resolveVaultResumeSpawn(args: {
  vaultResume: { operation: 'resume' | 'copy'; entry: AgentLaunchVaultResumeEntry }
  sessions: readonly VaultResumeSession[]
  hostPlatform: NodeJS.Platform
  settings?: VaultResumeAssemblySettings
}): VaultResumeSpawnResult {
  if (args.vaultResume.operation !== 'resume') {
    return { status: 'failed', failure: { code: 'invalid_launch_snapshot' } }
  }
  const session = findVaultResumeSession(args.vaultResume.entry, args.sessions)
  if (!session) {
    return { status: 'failed', failure: { code: 'invalid_launch_snapshot' } }
  }
  return {
    status: 'ok',
    startup: buildVaultResumeStartup({
      session,
      hostPlatform: args.hostPlatform,
      settings: args.settings
    })
  }
}

export type RevalidatedVaultResumeResolution =
  | { kind: 'snapshot'; request: AgentLaunchResumeRequest }
  | {
      kind: 'fallback'
      reason: 'missing' | 'ambiguous' | 'unsupported'
      startup: VaultResumeStartup
      launchNotices?: PersistedLaunchNoticeState
    }

/** Decide snapshot replay versus the disclosed current-settings fallback for an
 *  already fresh-scan-validated row. Both desktop and runtime callers use this
 *  exact correlation policy; only their scan and spawn mechanics differ. */
export function resolveRevalidatedVaultResume(args: {
  session: VaultResumeSession
  sessionRecordStore: AgentSessionRecordStore
  targetExecutionHostId: AgentLaunchExecutionHostId
  targetPlatform: NodeJS.Platform
  preferredWorktreeId?: string | null
  settings?: VaultResumeAssemblySettings
  mintNoticeToken?: () => string
}): RevalidatedVaultResumeResolution {
  if (isResumableTuiAgent(args.session.agent)) {
    const owner = args.sessionRecordStore.resolveVaultSnapshotOwner({
      baseAgent: args.session.agent,
      scannedProviderSessionId: args.session.sessionId,
      scannedTranscriptPath: args.session.filePath,
      targetExecutionHostId: args.targetExecutionHostId,
      targetPlatform: args.targetPlatform,
      preferredWorktreeId: args.preferredWorktreeId
    })
    if (owner.kind === 'found') {
      return {
        kind: 'snapshot',
        request: { resume: { operation: 'resume', sessionKey: owner.sessionKey } }
      }
    }
    return {
      kind: 'fallback',
      reason: owner.kind,
      startup: buildVaultResumeStartup({
        session: args.session,
        hostPlatform: args.targetPlatform,
        settings: args.settings
      }),
      launchNotices: {
        launchToken: (args.mintNoticeToken ?? randomUUID)(),
        notices: [
          {
            code: 'vault_original_config_unavailable',
            baseAgent: args.session.agent
          }
        ]
      }
    }
  }

  return {
    kind: 'fallback',
    reason: 'unsupported',
    startup: buildVaultResumeStartup({
      session: args.session,
      hostPlatform: args.targetPlatform,
      settings: args.settings
    })
  }
}

/** Expose only the original non-executable argv for an expanded, freshly
 * revalidated row. Missing or ambiguous private correlation never guesses. */
export function resolveRevalidatedVaultResumeDetails(args: {
  session: VaultResumeSession
  sessionRecordStore: AgentSessionRecordStore
}): VaultResumeDetailsResult {
  if (!isResumableTuiAgent(args.session.agent)) {
    return { status: 'unavailable' }
  }
  const snapshotArgs = args.sessionRecordStore.resolveVaultSnapshotArguments({
    baseAgent: args.session.agent,
    scannedProviderSessionId: args.session.sessionId,
    scannedTranscriptPath: args.session.filePath,
    scannedExecutionHostId: args.session.executionHostId
  })
  return snapshotArgs && snapshotArgs.length > 0
    ? { status: 'ok', args: snapshotArgs }
    : { status: 'unavailable' }
}

/** Build the resume startup for a re-validated (host-discovered) session. */
export function buildVaultResumeStartup(args: {
  session: VaultResumeSession
  /** The spawning host's platform, used only for local sessions; a non-local
   *  session uses its own discovered host platform. */
  hostPlatform: NodeJS.Platform
  settings?: VaultResumeAssemblySettings
  /** Copied text runs in a shell Orca never spawned and cannot seed, so the
   *  clearing must be embedded in the command as an `env -u` prefix. A spawned
   *  pane gets `envToDelete` instead. */
  forCopy?: boolean
}): VaultResumeStartup {
  const { session, hostPlatform, settings } = args
  const clearNames = aiVaultResumeClearEnvNames(session)
  const clearEnvNames = args.forCopy ? clearNames : undefined
  const envToDelete = args.forCopy || !clearNames ? undefined : [...clearNames]
  const commandOverride = settings?.agentCmdOverrides?.[session.agent as TuiAgent] ?? null
  const isRemote = !!session.executionHostId && session.executionHostId !== LOCAL_EXECUTION_HOST_ID
  // Remote-verbatim: a remote host stamped a ready-to-run resume command at
  // discovery time; replay it as-is rather than re-deriving remote semantics.
  if (isRemote && session.resumeCommand && !commandOverride?.trim()) {
    return { command: session.resumeCommand }
  }
  const platform: NodeJS.Platform =
    isRemote && session.executionHostPlatform ? session.executionHostPlatform : hostPlatform
  const codexHome = resolveVaultResumeCodexHome(session.codexHome ?? null, platform)
  // Why: the queued command is typed verbatim into a freshly spawned tab whose
  // live shell is the configured Windows shell (default PowerShell). Hardcoding
  // cmd quoting made PowerShell mis-parse the `""`-doubled wrapper (#6152), so
  // resolve the actual shell to quote per-shell instead. terminalWindowsShell
  // describes THIS host only, so a non-local Windows target falls back to its
  // own default PowerShell rather than borrowing the local setting.
  const queuedShell: AgentStartupShell | undefined =
    platform === 'win32'
      ? (resolveLocalWindowsAgentStartupShell({
          platform,
          isRemote,
          terminalWindowsShell: settings?.terminalWindowsShell
        }) ?? 'powershell')
      : undefined
  // Twin of resolveVaultResumeCodexHome: a WSL-discovered transcript is a UNC
  // path that no Linux resume argv can open.
  const resumeFilePath = normalizeAiVaultResumeFilePath(session.filePath, platform)
  if (isResumableTuiAgent(session.agent)) {
    const startupPlan = buildAgentResumeStartupPlan({
      agent: session.agent,
      // Antigravity keys on conversation_id; a hardcoded session_id makes its
      // resume argv lookup fail and drops it to the unstructured fallback.
      providerSession: {
        key: providerSessionKeyForResumableBase(session.agent),
        id: session.sessionId,
        // Pi/Prime-Agent resume by transcript path, not id: without the
        // host-derived path their resume argv is null and the session drops to
        // the unstructured fallback (no launchConfig, no resume at all).
        ...(resumeFilePath ? { transcriptPath: resumeFilePath } : {})
      },
      // OMP resumes by absolute transcript path; without it the argv falls back
      // to the session id, which misses a custom OMP_CODING_AGENT_DIR / WSL store.
      ompResumeFilePath: resumeFilePath ?? null,
      cmdOverrides: {
        ...settings?.agentCmdOverrides,
        ...(commandOverride?.trim() ? { [session.agent]: commandOverride } : {})
      },
      platform,
      shell: queuedShell,
      agentArgs: resolveTuiAgentLaunchArgs(session.agent, settings?.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(session.agent, settings?.agentDefaultEnv)
    })
    if (startupPlan) {
      return {
        command: buildAiVaultResumeShellCommand({
          resumeCommand: startupPlan.launchCommand,
          cwd: session.cwd,
          platform,
          codexHome,
          shell: queuedShell,
          clearEnvNames
        }),
        ...(startupPlan.env ? { env: startupPlan.env } : {}),
        ...(envToDelete ? { envToDelete } : {}),
        launchConfig: startupPlan.launchConfig
      }
    }
  }

  return {
    ...(envToDelete ? { envToDelete } : {}),
    command: buildAiVaultResumeCommand({
      agent: session.agent,
      sessionId: session.sessionId,
      // Why: OMP resumes by absolute transcript path, so local rebuilds must
      // forward the host-derived path — an id-prefix lookup scoped to the default
      // store would miss a custom OMP_CODING_AGENT_DIR / WSL-store session.
      resumeFilePath,
      cwd: session.cwd,
      platform,
      commandOverride,
      codexHome,
      // Why: non-resumable agents queue through this fallback too, so it must
      // quote for the live Windows shell like the startup-plan branch above.
      shell: queuedShell,
      clearEnvNames
    })
  }
}

function resolveVaultResumeCodexHome(
  codexHome: string | null,
  platform: NodeJS.Platform
): string | null {
  // Why: WSL UNC Codex homes must be POSIX when invoking Linux commands. Keep
  // original paths unchanged for non-Linux targets.
  if (!codexHome || platform !== 'linux') {
    return codexHome
  }
  return parseWslUncPath(codexHome)?.linuxPath ?? codexHome
}
