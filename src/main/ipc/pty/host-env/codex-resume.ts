import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { CodexAccountSelectionTarget } from '../../../codex-accounts/runtime-selection'
import type { CodexSessionResumePreparation } from '../../../codex/codex-session-resume-home'
import { CODEX_RESUME_AUTH_UNAVAILABLE_MESSAGE, codexHomePathsEqual } from './codex-home'
import type { PrepareCodexSessionResume } from './types'

export type CodexResumeLaunch = {
  codexResumeHome: Extract<CodexSessionResumePreparation, { outcome: 'resume' }> | null
  command: string | undefined
}

export type PreparedCodexResumeHome = {
  preparation: Promise<CodexSessionResumePreparation | null>
}

export type PrepareCodexResumeHomeArgs = {
  connectionId?: string | null
  launchAgent?: TuiAgent
  providerSession?: AgentProviderSessionMetadata
  target: CodexAccountSelectionTarget
  launchEnv?: NodeJS.ProcessEnv
  useSelectedAccount?: boolean
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
    preparation: prepareCodexSessionResume({
      providerSession,
      target: args.target,
      launchEnv: args.launchEnv,
      ...(args.useSelectedAccount ? { useSelectedAccount: true } : {})
    })
  }
}

/** Keep non-Codex preparation synchronous: an extra await changes pane-reservation race ordering. */
export function noCodexResumeLaunch(command: string | undefined): CodexResumeLaunch {
  return { codexResumeHome: null, command }
}

export function resolveCodexResumeLaunch(
  command: string | undefined,
  preparation: PreparedCodexResumeHome
): Promise<CodexResumeLaunch> {
  return preparation.preparation.then((prepared) => ({
    codexResumeHome: prepared?.outcome === 'resume' ? prepared : null,
    command
  }))
}

export async function reconcileSharedRuntimeResumeHome(
  resumeHome: Extract<CodexSessionResumePreparation, { outcome: 'resume' }>,
  resolveCurrentHome: () => string | null | Promise<string | null>
): Promise<string> {
  if (!resumeHome.reconcileSharedRuntimeAuth) {
    return resumeHome.codexHomePath
  }
  const currentHome = await resolveCurrentHome()
  if (!codexHomePathsEqual(currentHome, resumeHome.codexHomePath)) {
    throw new Error(CODEX_RESUME_AUTH_UNAVAILABLE_MESSAGE)
  }
  return resumeHome.codexHomePath
}
