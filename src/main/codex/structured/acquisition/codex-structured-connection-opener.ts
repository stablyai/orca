import { spawnCodexAppServerConnection } from '../../app-server/codex-app-server-connection'
import { sharedCodexServerPool } from '../../app-server/shared-servers/codex-shared-server-pool'
import {
  CodexSharedServerUncontainedError,
  windowsSharedServersAvailable
} from '../../app-server/shared-servers/codex-shared-server-windows-job'
import { codexSkillRoots } from '../launch/codex-structured-skill-roots'
import type {
  CodexStructuredLaunch,
  CodexStructuredSessionAdapterDeps
} from '../session-lifecycle/codex-structured-session-state'

/** Off, or a custom Codex command: the chat spawns its own app-server, as always. On: it leases a
 *  thread on a shared one. Windows shares only while each shared server's tree can be held in a
 *  job; otherwise it, too, keeps one server per chat. */
export function codexConnectionOpener(
  deps: Pick<CodexStructuredSessionAdapterDeps, 'openConnection' | 'sharedServers'>,
  sessionId: string,
  launch: Pick<
    CodexStructuredLaunch,
    'visuals' | 'linkedSkillsRoot' | 'codexVersion' | 'customCommand'
  >,
  platform: NodeJS.Platform = process.platform,
  windowsSharing: () => boolean = windowsSharedServersAvailable
): NonNullable<CodexStructuredSessionAdapterDeps['openConnection']> {
  if (deps.openConnection) {
    return deps.openConnection
  }
  if (launch.customCommand || deps.sharedServers?.() !== true) {
    return spawnCodexAppServerConnection
  }
  if (platform === 'win32' && !windowsSharing()) {
    return spawnCodexAppServerConnection
  }
  const skillRoots = codexSkillRoots({
    ...(launch.visuals ? { visualsSkillsRoot: launch.visuals.skill.skillsRoot } : {}),
    ...(launch.linkedSkillsRoot ? { linkedSkillsRoot: launch.linkedSkillsRoot } : {})
  })
  return (connectionLaunch, handlers) =>
    sharedCodexServerPool()
      .open(connectionLaunch, handlers ?? {}, {
        sessionId,
        skillRoots,
        codexVersion: launch.codexVersion ?? null
      })
      .catch((error: unknown) => {
        if (error instanceof CodexSharedServerUncontainedError) {
          return spawnCodexAppServerConnection(connectionLaunch, handlers)
        }
        throw error
      })
}
