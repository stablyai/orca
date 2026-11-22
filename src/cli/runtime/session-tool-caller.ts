import {
  CALLER_IDENTITY_ENV,
  ORCA_AGENT_SESSION_TOOL_TOKEN_ENV
} from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { RuntimeClient } from './client'

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
 *  trade it with this host once, before anything reads the identity. A refused or failed trade
 *  leaves no identity, so commands that act as a chat refuse instead of acting as another. */
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
  const answer = await trade(token).catch(() => null)
  const caller = isRecord(answer) && isRecord(answer.env) ? answer.env : {}
  for (const key of CALLER_IDENTITY_ENV) {
    const value = caller[key]
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value
    }
  }
}
