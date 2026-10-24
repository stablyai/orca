import type { NativeChatVisualsLaunch } from '../native-chat/native-chat-visuals-delivery'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { isCodexAppServerRequestError } from './codex-app-server-request-error'
import { isCodexMethodNotFoundError } from './codex-app-server-session'
import type { CodexStructuredPermissionPolicy } from './codex-structured-permission-policy'

/** Bound local setup requests so optional visuals do not delay the first prompt indefinitely. */
export const CODEX_VISUALS_SETUP_BUDGET_MS = 2_000

const SKILL_ROOTS_METHOD = 'skills/extraRoots/set'
const WRITABLE_ROOTS_KEY = 'sandbox_workspace_write.writable_roots'

type CodexVisualsConnection = Pick<CodexAppServerConnection, 'request'>

function isSkillRootsUnsupported(error: unknown): boolean {
  return (
    isCodexMethodNotFoundError(error) ||
    (isCodexAppServerRequestError(error) &&
      error.code === -32600 &&
      error.message.includes(`unknown variant \`${SKILL_ROOTS_METHOD}\``))
  )
}

/** extraRoots replaces the entire process list, so include every Orca root. */
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

/** Overrides replace Codex's list; merge readable user/project roots or leave configuration unchanged. */
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

export async function prepareCodexThreadForVisuals(
  connection: CodexVisualsConnection,
  launch: {
    cwd: string
    visuals?: NativeChatVisualsLaunch | null
    permissionPolicy?: CodexStructuredPermissionPolicy
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
    launch.permissionPolicy?.sandbox === 'danger-full-access'
      ? null
      : writableRootsConfig(connection, { cwd: launch.cwd, folder: visuals.folder }, report)
  ])
  return threadConfig
}

/** Codex reads roots at thread open; run setup after initialize and before opening. */
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
