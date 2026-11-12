import { z } from 'zod'
import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import { pluginResumeKey } from '../../../../shared/plugins/workers/plugin-agent-resume-key'
import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'
import { bind, type BoundPluginHostMethod } from './plugin-host-method-bind'
import { preparePluginPastSession, resumableTranscript } from './plugin-past-session-resume'
import {
  pluginHostEffect as effect,
  pluginHostRpc as rpc,
  pluginWorkspaceSelector as workspaceSelector
} from './plugin-host-runtime-call'
import { recordPluginOpenedTerminal } from './plugin-opened-terminals'
import type { PluginAgentStatusRow } from './plugin-workspace-projection'

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
          ? await preparePluginPastSession(ctx, {
              agent,
              sessionId,
              workspacePath: shown.path ?? null
            })
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
