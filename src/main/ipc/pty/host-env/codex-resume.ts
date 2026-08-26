import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session-resume'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'
import { dropAgentResumeArgvFromCommand } from '../../../../shared/agent-resume-argv-drop'
import type { CodexAccountSelectionTarget } from '../../../codex-accounts/runtime-selection'
import { dropUnverifiedCodexResumeArgv } from '../../../codex/codex-unverified-resume-launch'
import type { CodexSessionResumePreparation } from '../../../codex/codex-session-resume-home'
import { CODEX_RESUME_AUTH_UNAVAILABLE_MESSAGE, codexHomePathsEqual } from './codex-home'
import type { PrepareCodexSessionResume } from './types'

export type CodexResumeLaunch = {
  codexResumeHome: Extract<CodexSessionResumePreparation, { outcome: 'resume' }> | null
  command: string | undefined
  notifyResumeUnavailable: boolean
  droppedResumeArgv: boolean
  providerSession: AgentProviderSessionMetadata | null
}

export type PreparedCodexResumeHome = {
  providerSession: AgentProviderSessionMetadata
  preparation: Promise<CodexSessionResumePreparation | null>
}

export type PrepareCodexResumeHomeArgs = {
  connectionId?: string | null
  launchAgent?: TuiAgent
  providerSession?: AgentProviderSessionMetadata
  target: CodexAccountSelectionTarget
  launchEnv?: NodeJS.ProcessEnv
  workspacePath?: string
}

export function prepareCodexResumeHome(
  prepareCodexSessionResume: PrepareCodexSessionResume | undefined,
  args: PrepareCodexResumeHomeArgs
): PreparedCodexResumeHome | null {
  if (args.connectionId || args.launchAgent !== 'codex' || !prepareCodexSessionResume) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(args.providerSession)
  if (!providerSession) {
    return null
  }
  return {
    providerSession,
    preparation: prepareCodexSessionResume({
      providerSession,
      target: args.target,
      launchEnv: args.launchEnv,
      workspacePath: args.workspacePath
    })
  }
}

/** Kept separate from resolveCodexResumeLaunch so non-Codex spawns never await:
 *  an extra tick reorders the pane-spawn reservation races this handler arbitrates. */
export function noCodexResumeLaunch(command: string | undefined): CodexResumeLaunch {
  return {
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null
  }
}

/** The command a Codex launch actually runs: unchanged when provenance is verified,
 *  stripped of `resume <id>` when it is not. */
export function resolveCodexResumeLaunch(
  command: string | undefined,
  preparation: PreparedCodexResumeHome
): Promise<CodexResumeLaunch> {
  return preparation.preparation.then((prepared) => {
    const providerSession = preparation.providerSession
    if (prepared?.outcome !== 'fresh') {
      return {
        codexResumeHome: prepared ?? null,
        command,
        notifyResumeUnavailable: false,
        droppedResumeArgv: false,
        providerSession
      }
    }
    const dropped = dropUnverifiedCodexResumeArgv({
      command,
      providerSession,
      claimedCodexProvenance: prepared.claimedCodexProvenance
    })
    return {
      codexResumeHome: null,
      command: dropped.command,
      // Why: staying silent only makes sense for metadata that positively belongs to
      // another agent; a resume with no transcript path at all still owes the user a notice.
      notifyResumeUnavailable:
        dropped.droppedResumeArgv &&
        (prepared.claimedCodexProvenance || !providerSession.transcriptPath),
      droppedResumeArgv: dropped.droppedResumeArgv,
      providerSession
    }
  })
}

export function reconcileSharedRuntimeResumeHome(
  resumeHome: Extract<CodexSessionResumePreparation, { outcome: 'resume' }>,
  resolveCurrentHome: () => string | null
): string {
  if (!resumeHome.reconcileSharedRuntimeAuth) {
    return resumeHome.codexHomePath
  }
  const currentHome = resolveCurrentHome()
  if (!codexHomePathsEqual(currentHome, resumeHome.codexHomePath)) {
    throw new Error(CODEX_RESUME_AUTH_UNAVAILABLE_MESSAGE)
  }
  return resumeHome.codexHomePath
}

/** Why: buildPtyHostEnv prefers ORCA_SEQUENCED_STARTUP_COMMAND over the launch command
 *  and the sequenced wrapper `eval`s it, so a dropped resume argv has to go there too. */
export function stripSequencedStartupResumeArgv<T extends Record<string, string> | undefined>(
  env: T,
  launch: CodexResumeLaunch
): T {
  const sequenced = env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
  if (!env || !sequenced || !launch.droppedResumeArgv || !launch.providerSession) {
    return env
  }
  const drop = dropAgentResumeArgvFromCommand({
    command: sequenced,
    agent: 'codex',
    providerSession: launch.providerSession
  })
  return drop.status === 'dropped'
    ? { ...env, [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: drop.command }
    : env
}
