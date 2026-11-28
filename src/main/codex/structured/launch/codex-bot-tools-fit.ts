import {
  openWithoutRefusedCodexServers,
  withoutCodexMcpConflicts
} from '../../../bots/bot-tools-codex-conflicts'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { prepareCodexThreadSkills } from './codex-structured-skill-roots'

type Connection = Pick<CodexAppServerConnection, 'request'>
type Log = { logger?: StructuredAgentSessionLogger; sessionId: string }
type ThreadLaunch = Parameters<typeof prepareCodexThreadSkills>[1] & {
  threadConfig?: Record<string, unknown>
  linkedSkillsRefused?: () => void
}

function warnLeftOut(log: Log, names: readonly string[]): void {
  if (names.length > 0) {
    log.logger?.warn(
      'codex config has its own server under a bot tool name; the tool is left out',
      {
        scope: 'botTools.codex',
        sessionId: log.sessionId,
        names
      }
    )
  }
}

/**
 * The launch without the bot servers Codex can't add over its own same-named ones, so the chat
 * still starts; the owner's server keeps the name and the bot's tools row says why.
 */
export async function withCodexBotToolsFitted<T extends ThreadLaunch>(
  connection: Connection,
  launch: T,
  log: Log
): Promise<T> {
  if (!launch.threadConfig) {
    return launch
  }
  const { threadConfig, leftOut } = await withoutCodexMcpConflicts(
    connection,
    launch.cwd,
    launch.threadConfig
  )
  warnLeftOut(log, leftOut)
  return leftOut.length === 0 ? launch : { ...launch, threadConfig }
}

/**
 * The thread settings: the bot servers that fit Codex's config, `extra` (a read-only run's
 * switches; its failure fails the launch) and the skill roots, prepared together. `connection`
 * should share one config read (`sharingCodexConfigReads`); each step keeps its own deadline and
 * fallback.
 */
export async function codexThreadLaunch<T extends ThreadLaunch>(
  connection: Connection,
  launch: T,
  extra: Promise<Record<string, unknown>> | null,
  log: Log
): Promise<T> {
  const [fitted, skills, switches] = await Promise.all([
    withCodexBotToolsFitted(connection, launch, log),
    prepareCodexThreadSkills(connection, launch, log),
    extra
  ])
  if (!skills.rootsTaken) {
    launch.linkedSkillsRefused?.()
  }
  if (!switches && !skills.threadConfig) {
    return fitted
  }
  return {
    ...fitted,
    threadConfig: { ...fitted.threadConfig, ...switches, ...skills.threadConfig }
  }
}

/**
 * Opens the thread, leaving out a bot server Codex still refuses at open: a config it loads only
 * then (a project trusted as the thread starts) slips past the read before it.
 */
export async function openCodexThreadFitted<T>(
  threadConfig: Record<string, unknown> | undefined,
  open: (threadConfig: Record<string, unknown> | undefined) => Promise<T>,
  log: Log
): Promise<T> {
  const { opened, leftOut } = await openWithoutRefusedCodexServers(threadConfig, open)
  warnLeftOut(log, leftOut)
  return opened
}
