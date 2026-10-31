import { z } from 'zod'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { captureOmpSubagentStop } from './rpc-session-events'
import type { PiRpcConnection, PiRpcSession } from '../pi/rpc-session'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export async function supportsOmpSubagentStop(
  connection: Pick<PiRpcConnection, 'request'>
): Promise<boolean> {
  try {
    await connection.request('cancel_subagent', { subagentId: '' })
  } catch (error) {
    return (
      error instanceof JsonlRpcResponseError &&
      error.command === 'cancel_subagent' &&
      error.message === '`subagentId` must be a non-empty string.'
    )
  }
  return false
}

export async function stopOmpSubagents(
  session: PiRpcSession,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']>>[0],
  isCurrent: () => boolean
): Promise<{ cancelled: boolean; stillRunning?: true }> {
  const targets = [...new Set(input.taskIds)].map((id) => ({
    id,
    current: captureOmpSubagentStop(session, id)
  }))
  if (targets.some((target) => !target.current)) {
    throw new Error('OMP cannot stop a task that is not a live native subagent')
  }
  let cancelled = false
  let stillRunning = false
  for (const target of targets) {
    if (!isCurrent()) {
      break
    }
    if (!target.current?.()) {
      continue
    }
    const result = z
      .object({ cancelled: z.boolean() })
      .parse(await session.connection.request('cancel_subagent', { subagentId: target.id }))
    cancelled ||= result.cancelled
    if (!isCurrent()) {
      break
    }
    if (result.cancelled && target.current()) {
      input.acknowledge?.({ taskId: target.id })
    } else if (target.current()) {
      stillRunning = true
    }
  }
  return { cancelled, ...(stillRunning ? { stillRunning: true as const } : {}) }
}
