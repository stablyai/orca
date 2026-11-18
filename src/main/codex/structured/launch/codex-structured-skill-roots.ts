import {
  nativeChatVisualsWritableFolders,
  type NativeChatVisualsLaunch
} from '../../../native-chat/conversation-files/native-chat-visuals-delivery'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { isCodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import {
  isCodexAppServerUnsupportedError,
  isCodexMethodNotFoundError,
  type CodexAppServerRpc
} from '../../app-server/codex-app-server-session'
import type { CodexStructuredPermissionPolicy } from '../../../../shared/agent-launch/permissions/codex-permission-policy'

/** Bound local setup requests so optional visuals do not delay the first prompt indefinitely. */
export const CODEX_VISUALS_SETUP_BUDGET_MS = 2_000

const SKILL_ROOTS_METHOD = 'skills/extraRoots/set'
const WRITABLE_ROOTS_KEY = 'sandbox_workspace_write.writable_roots'

type CodexVisualsConnection = Pick<CodexAppServerConnection, 'request'>

/** Codex can't load skills by path (it predates skill roots); any other failure says nothing. */
export function isCodexSkillRootsUnsupported(error: unknown): boolean {
  return (
    isCodexMethodNotFoundError(error) ||
    isCodexAppServerUnsupportedError(error) ||
    (isCodexAppServerRequestError(error) &&
      error.code === -32600 &&
      error.message.includes(`unknown variant \`${SKILL_ROOTS_METHOD}\``))
  )
}

/** extraRoots replaces the entire process list, so include every root: visuals, then linked
 *  projects'. A chat's launch and its resting `/` probe both load these. */
export function codexSkillRoots(roots: {
  visualsSkillsRoot?: string
  linkedSkillsRoot?: string
}): string[] {
  return [
    ...(roots.visualsSkillsRoot ? [roots.visualsSkillsRoot] : []),
    ...(roots.linkedSkillsRoot ? [roots.linkedSkillsRoot] : [])
  ]
}

/** Gives Codex these roots; rejects when it didn't take them (`isCodexSkillRootsUnsupported`
 *  tells a Codex that can't from a failure). */
export async function setCodexSkillRoots(
  connection: Pick<CodexAppServerConnection, 'request'> | Pick<CodexAppServerRpc, 'request'>,
  roots: string[]
): Promise<void> {
  await connection.request(
    SKILL_ROOTS_METHOD,
    { extraRoots: roots },
    { timeoutMs: CODEX_VISUALS_SETUP_BUDGET_MS }
  )
}

/** Whether Codex took the roots; a launch goes on without them either way. */
async function setSkillRoots(
  connection: CodexVisualsConnection,
  roots: string[],
  report: (message: string, error: unknown) => void
): Promise<boolean> {
  try {
    await setCodexSkillRoots(connection, roots)
    return true
  } catch (error) {
    report(
      isCodexSkillRootsUnsupported(error)
        ? 'codex app-server cannot load skills by path; the chat loads no extra skill folders'
        : 'codex app-server did not take the extra skill roots',
      error
    )
    return false
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
  input: { cwd: string; folders: string[] },
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
    return { [WRITABLE_ROOTS_KEY]: [...new Set([...roots, ...input.folders])] }
  } catch (error) {
    report('codex config/read failed; the chat folder is not a writable root', error)
    return null
  }
}

type CodexSkillRootsLaunch = {
  cwd: string
  visuals?: NativeChatVisualsLaunch | null
  linkedSkillsRoot?: string
  permissionPolicy?: CodexStructuredPermissionPolicy
}

export async function prepareCodexThreadSkills(
  connection: CodexVisualsConnection,
  launch: CodexSkillRootsLaunch,
  log?: { logger?: StructuredAgentSessionLogger; sessionId: string }
): Promise<{ threadConfig: Record<string, unknown> | null; rootsTaken: boolean }> {
  const { visuals } = launch
  const roots = codexSkillRoots({
    ...(visuals ? { visualsSkillsRoot: visuals.skill.skillsRoot } : {}),
    ...(launch.linkedSkillsRoot ? { linkedSkillsRoot: launch.linkedSkillsRoot } : {})
  })
  if (roots.length === 0) {
    return { threadConfig: null, rootsTaken: false }
  }
  const report = (message: string, error: unknown): void =>
    log?.logger?.warn(message, {
      scope: 'nativeChatVisuals.codex',
      sessionId: log.sessionId,
      ...(error === null ? {} : { error })
    })
  const [rootsTaken, threadConfig] = await Promise.all([
    setSkillRoots(connection, roots, report),
    !visuals || launch.permissionPolicy?.sandbox === 'danger-full-access'
      ? null
      : writableRootsConfig(
          connection,
          { cwd: launch.cwd, folders: nativeChatVisualsWritableFolders(visuals) },
          report
        )
  ])
  return { threadConfig, rootsTaken }
}

/** Codex takes roots at thread open and rereads their contents; run setup after initialize and
 *  before opening. A Codex that takes no roots has the linked skills listed on the bot's next turn. */
export async function withCodexSkillRootsThreadConfig<
  T extends CodexSkillRootsLaunch & {
    threadConfig?: Record<string, unknown>
    linkedSkillsRefused?: () => void
  }
>(
  connection: CodexVisualsConnection,
  launch: T,
  log: { logger?: StructuredAgentSessionLogger; sessionId: string }
): Promise<T & { threadConfig?: Record<string, unknown> }> {
  const { threadConfig, rootsTaken } = await prepareCodexThreadSkills(connection, launch, log)
  if (!rootsTaken) {
    launch.linkedSkillsRefused?.()
  }
  return threadConfig
    ? { ...launch, threadConfig: { ...launch.threadConfig, ...threadConfig } }
    : launch
}
