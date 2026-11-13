import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
  aiVaultHistoryAgents,
  isAiVaultAgent
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  aiVaultSessionAfterResumePreparation,
  aiVaultTerminalResumeRequest,
  aiVaultTerminalResumeResult,
  type AiVaultPrepareSessionResumeArgs,
  type AiVaultPrepareSessionResumeResult
} from '../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { ProviderSession } from '../../../../shared/rpc-contract/terminal/agent-session-params'
import { codexDatedRolloutRelativePath } from '../../../codex/history/resume/codex-session-resume-home'
import type { PluginHostMethodContext } from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'
import { pluginHostEffect as effect } from './plugin-host-runtime-call'
import { findPluginPastSession } from './plugin-host-agent-history-bindings'
import type { PluginHistorySession } from './plugin-agent-history'

// The parts of the host's answer a terminal resume applies; anything else refuses it.
const preparedAnswer = z.object({
  useRealCodexHome: z.boolean(),
  substituteCodexHome: z.string().optional()
})

/** A transcript the resume launch accepts, else none. */
export function resumableTranscript(path: string | undefined): string | undefined {
  const transcript = ProviderSession.shape.transcriptPath.safeParse(path)
  return transcript.success ? transcript.data : undefined
}

/**
 * The transcript to resume from once the host prepared the session. Repinned to the selected
 * account (`substituteCodexHome`): that account's hard-linked copy, since the launch picks the
 * account whose home holds the transcript it is given, as the desktop pins that home. Otherwise
 * the recorded transcript: for `useRealCodexHome` the launch moves a legacy session into the
 * system home itself, wherever that home is configured.
 */
export function preparedResumeTranscript(
  session: Pick<PluginHistorySession, 'filePath' | 'codexHome'>,
  result: AiVaultPrepareSessionResumeResult
): string {
  const prepared = aiVaultSessionAfterResumePreparation(session, result)
  if (!session.codexHome || !prepared.codexHome || prepared.codexHome === session.codexHome) {
    return session.filePath
  }
  const rollout = codexDatedRolloutRelativePath(
    join(session.codexHome, 'sessions'),
    resolve(session.filePath)
  )
  return rollout ? join(prepared.codexHome, 'sessions', rollout) : session.filePath
}

async function findPastSession(
  ctx: PluginHostMethodContext,
  match: { agent: string; sessionId: string; workspacePath: string | null }
): Promise<PluginHistorySession | null> {
  if (!isAiVaultAgent(match.agent)) {
    return null
  }
  try {
    return await findPluginPastSession(ctx, {
      agents: aiVaultHistoryAgents(match.agent),
      sessionId: match.sessionId,
      workspacePath: match.workspacePath
    })
  } catch (error) {
    if (error instanceof PluginHostCallError && error.code === 'consent_required') {
      throw error
    }
    // History that cannot be read now leaves the resume as before: by id.
    const detail = error instanceof PluginHostCallError ? (error.detail ?? error.message) : error
    ctx.scope.log?.(`agent.resume: Agent Session History is unavailable: ${String(detail)}`)
    return null
  }
}

/**
 * A session no pane runs, readied as Orca's own terminal Resume from Agent Session History
 * readies it (the same request and answer handling): an older Codex home's transcript moved
 * where `codex resume` finds it, a session repinned to the selected account, a session an Orca
 * chat owns refused. Answers the transcript to resume from, or undefined when this computer's
 * history does not list the session: the agent then resumes it by id.
 */
export async function preparePluginPastSession(
  ctx: PluginHostMethodContext,
  match: { agent: string; sessionId: string; workspacePath: string | null }
): Promise<string | undefined> {
  const session = await findPastSession(ctx, match)
  if (!session || !isAiVaultAgent(session.agent)) {
    return undefined
  }
  const args: AiVaultPrepareSessionResumeArgs = {
    agent: session.agent,
    sessionId: session.sessionId,
    filePath: session.filePath,
    codexHome: session.codexHome,
    executionHostId: LOCAL_EXECUTION_HOST_ID
  }
  let result: AiVaultPrepareSessionResumeResult
  try {
    const answer = await effect(
      ctx,
      'aiVault.prepareSessionResume',
      aiVaultTerminalResumeRequest(args)
    )
    const parsed = preparedAnswer.safeParse(answer)
    result = aiVaultTerminalResumeResult(args, parsed.success ? parsed.data : null)
  } catch (error) {
    if (error instanceof PluginHostCallError && error.code === 'consent_required') {
      throw error
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw error
    }
    throw new PluginHostCallError(
      'action_failed',
      'Orca could not prepare this session to resume',
      undefined,
      error instanceof PluginHostCallError ? (error.detail ?? error.message) : String(error),
      { cause: error }
    )
  }
  return resumableTranscript(preparedResumeTranscript(session, result))
}
