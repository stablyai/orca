import {
  CALLER_IDENTITY_ENV,
  ORCA_AGENT_SESSION_TOOL_TOKEN_ENV
} from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { RuntimeClient } from './client'
import { RuntimeClientError } from './connection/types'

/** This host's answer for a token: `{ env }`, the session's identity, or `{ env: null }`. */
export async function tradeSessionToolToken(
  client: Pick<RuntimeClient, 'call'>,
  token: string
): Promise<unknown> {
  return (await client.call('agentSession.toolCaller', { token }, { timeoutMs: 10_000 })).result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A chat whose tools run in a process other chats share carries a token in place of its identity:
 *  trade it with this host once, before anything reads the identity. Without an answer the command
 *  runs nothing: as no one it would pass as the owner, past a bot's own limits. */
export async function adoptSessionToolCaller(
  env: NodeJS.ProcessEnv,
  trade: (token: string) => Promise<unknown>
): Promise<void> {
  const token = env[ORCA_AGENT_SESSION_TOOL_TOKEN_ENV]?.trim()
  if (!token) {
    return
  }
  delete env[ORCA_AGENT_SESSION_TOOL_TOKEN_ENV]
  // The shared process's own identity is whichever chat started it.
  for (const key of CALLER_IDENTITY_ENV) {
    delete env[key]
  }
  const answer = await trade(token).catch((error: unknown) => {
    throw new RuntimeClientError(
      'session_tool_caller_unavailable',
      `Orca could not confirm which chat ran this command, so it ran nothing: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  const caller = isRecord(answer) && isRecord(answer.env) ? answer.env : null
  if (!caller) {
    throw new RuntimeClientError(
      'session_tool_caller_ended',
      "This command's chat process has ended in Orca (the chat closed or restarted, or Orca did), so it ran nothing. Run it again from the chat."
    )
  }
  for (const key of CALLER_IDENTITY_ENV) {
    const value = caller[key]
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value
    }
  }
}
