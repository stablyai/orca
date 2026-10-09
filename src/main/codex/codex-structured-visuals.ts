// Inline visuals for a Codex chat, set up on its app-server between initialize and the thread
// open: the skill root Codex scans, and the chat's folder as a writable root. Both are best effort
// under one short budget; a chat whose setup fails, hangs or is unsupported opens without visuals.

import type { NativeChatVisualsLaunch } from '../native-chat/native-chat-visuals-delivery'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { isCodexAppServerRequestError } from './codex-app-server-request-error'
import { isCodexMethodNotFoundError } from './codex-app-server-session'

/** Why short: both requests answer from local state in milliseconds, and the user's first prompt
 *  waits behind them; past this the thread opens without whatever has not answered. */
export const CODEX_VISUALS_SETUP_BUDGET_MS = 2_000

const SKILL_ROOTS_METHOD = 'skills/extraRoots/set'
const WRITABLE_ROOTS_KEY = 'sandbox_workspace_write.writable_roots'

type CodexVisualsConnection = Pick<CodexAppServerConnection, 'request'>

/** A Codex that predates the method: older builds refuse it as an unknown request variant. */
function isSkillRootsUnsupported(error: unknown): boolean {
  return (
    isCodexMethodNotFoundError(error) ||
    (isCodexAppServerRequestError(error) &&
      error.code === -32600 &&
      error.message.includes(`unknown variant \`${SKILL_ROOTS_METHOD}\``))
  )
}

/**
 * The skill roots Orca hands this app-server. The request replaces the process's whole list, so
 * every root Orca supplies is named here; each chat has its own app-server, and this runs on every
 * acquisition, so a respawned or resumed chat gets the list again.
 */
function orcaSkillRoots(visuals: NativeChatVisualsLaunch): string[] {
  return [visuals.skill.skillsRoot]
}

async function setSkillRoots(
  connection: CodexVisualsConnection,
  visuals: NativeChatVisualsLaunch,
  report: (message: string, error: unknown) => void
): Promise<void> {
  try {
    await connection.request(
      SKILL_ROOTS_METHOD,
      { extraRoots: orcaSkillRoots(visuals) },
      { timeoutMs: CODEX_VISUALS_SETUP_BUDGET_MS }
    )
  } catch (error) {
    report(
      isSkillRootsUnsupported(error)
        ? 'codex app-server cannot load skills by path; the chat has no visuals skill'
        : 'codex app-server did not take the visuals skill root',
      error
    )
  }
}

function writableRootsOf(response: unknown): string[] | null {
  if (typeof response !== 'object' || response === null || !('config' in response)) {
    return null
  }
  const { config } = response
  if (typeof config !== 'object' || config === null) {
    return null
  }
  const section = 'sandbox_workspace_write' in config ? config.sandbox_workspace_write : null
  if (section === null || section === undefined) {
    return []
  }
  if (typeof section !== 'object' || !('writable_roots' in section)) {
    return []
  }
  const roots = section.writable_roots
  return Array.isArray(roots) && roots.every((root) => typeof root === 'string') ? roots : null
}

/**
 * The thread config adding the chat's folder to the writable roots the user already has. The
 * override replaces Codex's list rather than appending to it, so the user's own roots are read
 * first (with the project layers this cwd sees) and kept; when they can't be read, nothing is
 * overridden and a write there asks for approval like any other path outside the workspace.
 */
async function writableRootsConfig(
  connection: CodexVisualsConnection,
  input: { cwd: string; folder: string },
  report: (message: string, error: unknown) => void
): Promise<Record<string, unknown> | null> {
  try {
    const roots = writableRootsOf(
      await connection.request(
        'config/read',
        { cwd: input.cwd },
        { timeoutMs: CODEX_VISUALS_SETUP_BUDGET_MS }
      )
    )
    if (!roots) {
      report('codex config/read gave no readable writable roots', null)
      return null
    }
    return { [WRITABLE_ROOTS_KEY]: [...new Set([...roots, input.folder])] }
  } catch (error) {
    report('codex config/read failed; the chat folder is not a writable root', error)
    return null
  }
}

/**
 * Sets this app-server up for the chat's visuals and returns the thread config the thread open
 * carries, or null. Never throws. Full access gets the writable root too: the chat can leave it.
 */
export async function prepareCodexThreadForVisuals(
  connection: CodexVisualsConnection,
  launch: {
    cwd: string
    visuals?: NativeChatVisualsLaunch | null
  },
  log?: { logger?: StructuredAgentSessionLogger; sessionId: string }
): Promise<Record<string, unknown> | null> {
  const { visuals } = launch
  if (!visuals) {
    return null
  }
  const report = (message: string, error: unknown): void =>
    log?.logger?.warn(message, {
      scope: 'nativeChatVisuals.codex',
      sessionId: log.sessionId,
      ...(error === null ? {} : { error })
    })
  const [, threadConfig] = await Promise.all([
    setSkillRoots(connection, visuals, report),
    writableRootsConfig(connection, { cwd: launch.cwd, folder: visuals.folder }, report)
  ])
  return threadConfig
}

/** The writable roots a thread opened with, for a turn that restates its sandbox. */
export function codexThreadWritableRoots(threadConfig: Record<string, unknown> | undefined) {
  const roots = threadConfig?.[WRITABLE_ROOTS_KEY]
  return Array.isArray(roots) ? roots.filter((root) => typeof root === 'string') : undefined
}

/** `launch` carrying its visuals thread config, set up on this app-server first. Codex reads skill
 *  roots and writable roots when a thread opens, so this runs between initialize and the open. */
export async function withCodexVisualsThreadConfig<
  T extends Parameters<typeof prepareCodexThreadForVisuals>[1]
>(
  connection: CodexVisualsConnection,
  launch: T,
  log: { logger?: StructuredAgentSessionLogger; sessionId: string }
): Promise<T & { threadConfig?: Record<string, unknown> }> {
  const threadConfig = await prepareCodexThreadForVisuals(connection, launch, log)
  return threadConfig ? { ...launch, threadConfig } : launch
}
