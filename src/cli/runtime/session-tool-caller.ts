import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CALLER_IDENTITY_ENV,
  ORCA_AGENT_SESSION_TOOL_TOKEN_ENV,
  SHARED_TOOL_PROCESS_BOT_FIELD,
  SHARED_TOOL_PROCESS_SESSION_FILES,
  SHARED_TOOL_PROCESS_SESSION_ID_PATTERN
} from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type { RuntimeClient } from './client'
import { resolveHermesActiveProfileHome } from '../../shared/hermes/hermes-active-profile-home'
import { RuntimeClientError } from './connection/types'

/** This host's answer for a token: `{ env }`, the session's identity, or `{ env: null }`. */
export async function tradeSessionToolToken(
  client: Pick<RuntimeClient, 'call'>,
  token: string
): Promise<unknown> {
  return (await client.call('agentSession.toolCaller', { token }, { timeoutMs: 10_000 })).result
}

/** A bot's session Orca published for the tool's own session, whose token didn't reach the tool. */
async function publishedBotSession(env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const place of SHARED_TOOL_PROCESS_SESSION_FILES) {
    const given = env[place.homeEnv]?.trim() || join(homedir(), place.defaultHome)
    // A root home runs its active profile, where Orca published the session.
    const homes = [...new Set([given, await resolveHermesActiveProfileHome(given)])]
    for (const name of place.sessionIdEnvs) {
      const sessionId = env[name]?.trim()
      if (
        !sessionId ||
        !new RegExp(`^${SHARED_TOOL_PROCESS_SESSION_ID_PATTERN}$`).test(sessionId)
      ) {
        continue
      }
      for (const home of homes) {
        const file = await readFile(join(home, place.dir, `${sessionId}.json`), 'utf-8').catch(
          () => null
        )
        const published: unknown = file ? safeJson(file) : null
        if (isRecord(published) && published[SHARED_TOOL_PROCESS_BOT_FIELD] === '1') {
          return true
        }
      }
    }
  }
  return false
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
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
    if (await publishedBotSession(env)) {
      throw new RuntimeClientError(
        'session_tool_caller_missing',
        "This bot's tool ran without its Orca identity (its chat closed, or Orca's plugin stopped serving it), so it ran nothing. Start a new chat with the bot."
      )
    }
    return
  }
  // The token stays: a CLI that runs itself again (packaged re-entry) trades it again.
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
