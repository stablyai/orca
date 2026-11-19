// The line a turn from a conversation with live work carries: which worker to send follow-ups to.
import {
  sessionWorkerIsRunning,
  type OrchestrationSessionWorkerState
} from '../../shared/orchestration-session-workers'
import { BOT_ORCA_CLI } from './bot-preamble'
import type { BotWorkCheck } from './bot-work-types'

const STATE_WORDS: Record<OrchestrationSessionWorkerState, string> = {
  working: 'still working',
  completed: 'finished',
  failed: 'finished with a failure',
  stopped: 'no longer running',
  unverifiable: 'out of contact'
}

/** One line, at most 120 characters; nothing in it reads as Orca's own brackets, quotes or code. */
export function cleanBotWorkText(text: string): string {
  return text
    .replace(/[[\]`"\s]+/g, ' ')
    .trim()
    .slice(0, 120)
}

export function botWorkTurnNote({ row, worker, workspace }: BotWorkCheck): string {
  const send = (dispatchId: string) =>
    `\`${BOT_ORCA_CLI} orchestration send --to dispatch:${dispatchId}\``
  if (!worker) {
    return `[Orca: this conversation's code work belongs to worker dispatch:${row.dispatchId}, whose state can't be read now. Send follow-ups on this work to it with ${send(row.dispatchId)}; a new, unrelated request may start a new worker.]`
  }
  const where = workspace ? ` in ${cleanBotWorkText(workspace.name)}` : ''
  const on = worker.hostName ? ` on ${cleanBotWorkText(worker.hostName)}` : ''
  const who = `worker "${cleanBotWorkText(worker.title)}"${worker.agent ? ` (${worker.agent})` : ''}${where}${on}, ${worker.idle ? 'idle' : STATE_WORDS[worker.state]}`
  if (worker.host !== 'local' && !sessionWorkerIsRunning(worker)) {
    // A paired server refuses `send` to a finished worker.
    const worktree = worker.worktreeId ? ` --worktree id:${worker.worktreeId}` : ''
    return `[Orca: this conversation's code work belongs to ${who}. Its server takes no follow-ups for it, so start a new worker in its workspace: \`${BOT_ORCA_CLI} orchestration worker-start --on "${cleanBotWorkText(worker.hostName ?? worker.host)}"${worktree} --spec "..."\`.]`
  }
  return `[Orca: this conversation's code work belongs to ${who}. Send follow-ups on this work to it with ${send(worker.dispatchId)}; a new, unrelated request may start a new worker.]`
}
