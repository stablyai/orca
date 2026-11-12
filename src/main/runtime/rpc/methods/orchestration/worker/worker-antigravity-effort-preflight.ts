import { assertAntigravityTerminalEffort } from '../../../../terminal/catalog/antigravity-terminal-effort'
import { resolveWorkerStartModeOnHost } from '../structured-workers/orchestration-worker-start-mode'
import { chatWorkerMode, type chatAssigneeOf } from '../chat-assignee-admission'
import type { startLocalWorker } from './local-worker-start'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'

export async function workerTerminalMode(
  args: Pick<Parameters<typeof startLocalWorker>[0], 'runtime' | 'params' | 'followUp' | 'mode'>,
  agent: TuiAgent | undefined,
  worktree: { id: string } | undefined,
  creation: { repoSelector: string } | undefined,
  chat: ReturnType<typeof chatAssigneeOf>
) {
  const hostMode = await resolveWorkerStartModeOnHost(args.runtime, args.mode, worktree?.id, agent)
  const mode = chatWorkerMode(hostMode, chat)
  if (!args.followUp && mode.mode === 'terminal' && !args.params.terminal) {
    await assertAntigravityTerminalEffort(args.runtime, {
      agent,
      model: args.params.model,
      effort: args.params.effort,
      ...(creation ? { repo: creation.repoSelector } : { worktree: `id:${worktree?.id}` })
    })
  }
  return mode
}
