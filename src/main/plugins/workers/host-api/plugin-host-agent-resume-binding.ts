import { z } from 'zod'
import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import { pluginResumeKey } from '../../../../shared/plugins/workers/plugin-agent-resume-key'
import { ProviderSession } from '../../../../shared/rpc-contract/agent-session-params'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'
import {
  aiVaultHistoryAgents,
  isAiVaultAgent
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  aiVaultSessionNeedsResumePreparation,
  type AiVaultPrepareSessionResumeArgs
} from '../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import {
  bind,
  type BoundPluginHostMethod,
  type PluginHostMethodContext
} from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'
import { findPluginPastSession } from './plugin-host-agent-history-bindings'
import {
  pluginHostEffect as effect,
  pluginHostRpc as rpc,
  pluginWorkspaceSelector as workspaceSelector
} from './plugin-host-runtime-call'
import { recordPluginOpenedTerminal } from './plugin-opened-terminals'
import type { PluginAgentStatusRow } from './plugin-workspace-projection'
import type { PluginHistorySession } from './plugin-agent-history'

const worktreeShowAnswer = z.object({
  worktree: z.object({ id: z.string(), hostId: z.string().optional(), path: z.string().optional() })
})
const ensureSessionAnswer = z.object({
  terminal: z.object({ handle: z.string() }),
  disposition: z.enum(['created', 'adopted'])
})

/** The live row of this session in this workspace, whose transcript some agents resume from;
 *  a same-id session elsewhere is another agent's. */
function liveRow(
  rows: readonly PluginAgentStatusRow[],
  match: { agent: string; sessionId: string; worktreeId: string; hostId: string }
): PluginAgentStatusRow | undefined {
  return rows.find(
    (candidate) =>
      candidate.agentType === match.agent &&
      candidate.providerSession?.id === match.sessionId &&
      candidate.worktreeId === match.worktreeId &&
      getConnectionExecutionHostId(candidate.connectionId) === match.hostId
  )
}

function resumableTranscript(path: string | undefined): string | undefined {
  const transcript = ProviderSession.shape.transcriptPath.safeParse(path)
  return transcript.success ? transcript.data : undefined
}

/**
 * A session no pane runs, readied as Orca's own Resume from Agent Session History readies it
 * (an older Codex home's transcript moved where `codex resume` finds it; a session an Orca chat
 * owns refused), and its transcript, which the launch uses to pick the agent account that holds
 * it. Undefined when this computer's history does not list it: the agent then resumes it by id.
 */
async function preparePastSession(
  ctx: PluginHostMethodContext,
  match: { agent: string; sessionId: string; workspacePath: string | null }
): Promise<string | undefined> {
  if (!isAiVaultAgent(match.agent)) {
    return undefined
  }
  let session: PluginHistorySession | null
  try {
    session = await findPluginPastSession(ctx, {
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
    return undefined
  }
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
  try {
    // As the desktop's terminal resume: the home is readied only where the session needs it,
    // and ownership is checked either way.
    await effect(ctx, 'aiVault.prepareSessionResume', {
      ...args,
      codexHome: aiVaultSessionNeedsResumePreparation(args) ? args.codexHome : null
    })
  } catch (error) {
    if (!(error instanceof PluginHostCallError) || error.code === 'consent_required') {
      throw error
    }
    throw new PluginHostCallError(
      'action_failed',
      'Orca could not prepare this session to resume',
      undefined,
      error.detail ?? error.message,
      { cause: error }
    )
  }
  return resumableTranscript(session.filePath)
}

export const PLUGIN_AGENT_RESUME_HANDLERS = {
  'agent.resume': bind(
    PLUGIN_HOST_API['agent.resume'],
    async ({ workspaceId, agent, sessionId }, ctx) => {
      const worktree = workspaceSelector(workspaceId)
      const shown = worktreeShowAnswer.parse(
        await rpc(ctx.services)('worktree.show', { worktree })
      ).worktree
      const hostId = shown.hostId ?? LOCAL_EXECUTION_HOST_ID
      const live = liveRow(ctx.services.listAgentStatuses(), {
        agent,
        sessionId,
        worktreeId: shown.id,
        hostId
      })
      const transcriptPath = live
        ? resumableTranscript(live.providerSession?.transcriptPath)
        : // History lists this computer's sessions only; another host's agent resumes by id.
          hostId === LOCAL_EXECUTION_HOST_ID
          ? await preparePastSession(ctx, { agent, sessionId, workspacePath: shown.path ?? null })
          : undefined
      const answer = ensureSessionAnswer.parse(
        await effect(ctx, 'terminal.ensureAgentSession', {
          kind: 'explicit',
          worktree,
          agent,
          providerSession: {
            // The params schema admits only agents that resume by session id.
            key: pluginResumeKey(agent) ?? 'session_id',
            id: sessionId,
            ...(transcriptPath ? { transcriptPath } : {})
          },
          // A mod works beside the person: never take their focus.
          presentation: 'background'
        })
      )
      const started = answer.disposition === 'created'
      // A terminal that already ran the session is not the plugin's to close; one it started is,
      // unless the plugin lost approval while it started.
      if (started) {
        ctx.scope.assertActive()
        recordPluginOpenedTerminal(ctx.pluginId, answer.terminal.handle)
      }
      return { terminalId: answer.terminal.handle, started }
    }
  )
} satisfies Record<string, BoundPluginHostMethod>
