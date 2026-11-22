import { spawnCodexAppServerConnection } from '../../app-server/codex-app-server-connection'
import { sharedCodexServerPool } from '../../app-server/shared-servers/codex-shared-server-pool'
import { isSlackExecutionId } from '../../../native-chat/agent-session-wire/operations/slack-execution-authority'
import { codexSkillRoots } from '../launch/codex-structured-skill-roots'
import type {
  CodexStructuredLaunch,
  CodexStructuredSessionAdapterDeps
} from '../session-lifecycle/codex-structured-session-state'

type CodexConnectionOpen = NonNullable<CodexStructuredSessionAdapterDeps['openConnection']>

const sharedOpeners = new WeakSet<CodexConnectionOpen>()

/** A shared server is many chats' process, so no one chat's recovery may ever signal it. */
export function opensSharedCodexServer(open: CodexConnectionOpen): boolean {
  return sharedOpeners.has(open)
}

/** Slack-scoped executions keep a dedicated app-server even when process sharing is enabled. */
export function codexConnectionOpener(
  deps: Pick<CodexStructuredSessionAdapterDeps, 'openConnection' | 'sharedServers'>,
  sessionId: string,
  launch: Pick<
    CodexStructuredLaunch,
    'visuals' | 'linkedSkillsRoot' | 'codexVersion' | 'customCommand'
  >,
  platform: NodeJS.Platform = process.platform
): CodexConnectionOpen {
  if (deps.openConnection) {
    return deps.openConnection
  }
  // Windows can't read a process's environment, so a shared chat's Stop could never be proven
  // there; every Windows chat keeps its own server.
  if (
    isSlackExecutionId(sessionId) ||
    platform === 'win32' ||
    launch.customCommand ||
    deps.sharedServers?.() !== true
  ) {
    return spawnCodexAppServerConnection
  }
  const skillRoots = codexSkillRoots({
    ...(launch.visuals ? { visualsSkillsRoot: launch.visuals.skill.skillsRoot } : {}),
    ...(launch.linkedSkillsRoot ? { linkedSkillsRoot: launch.linkedSkillsRoot } : {})
  })
  const open: CodexConnectionOpen = (connectionLaunch, handlers) =>
    sharedCodexServerPool().open(connectionLaunch, handlers ?? {}, {
      sessionId,
      skillRoots,
      codexVersion: launch.codexVersion ?? null
    })
  sharedOpeners.add(open)
  return open
}
