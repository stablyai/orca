import { spawnCodexAppServerConnection } from '../../app-server/codex-app-server-connection'
import { sharedCodexServerPool } from '../../app-server/shared-servers/codex-shared-server-pool'
import { codexSkillRoots } from '../launch/codex-structured-skill-roots'
import type {
  CodexStructuredLaunch,
  CodexStructuredSessionAdapterDeps
} from '../session-lifecycle/codex-structured-session-state'

/** Off, Windows, or a custom Codex command: the chat spawns its own app-server, as always. On: it leases a
 *  thread on a shared one. */
export function codexConnectionOpener(
  deps: Pick<CodexStructuredSessionAdapterDeps, 'openConnection' | 'sharedServers'>,
  sessionId: string,
  launch: Pick<
    CodexStructuredLaunch,
    'visuals' | 'linkedSkillsRoot' | 'codexVersion' | 'customCommand'
  >,
  platform: NodeJS.Platform = process.platform
): NonNullable<CodexStructuredSessionAdapterDeps['openConnection']> {
  if (deps.openConnection) {
    return deps.openConnection
  }
  // Windows can't read a process's environment, so a shared chat's Stop could never be proven
  // there; every Windows chat keeps its own server.
  if (platform === 'win32' || launch.customCommand || deps.sharedServers?.() !== true) {
    return spawnCodexAppServerConnection
  }
  const skillRoots = codexSkillRoots({
    ...(launch.visuals ? { visualsSkillsRoot: launch.visuals.skill.skillsRoot } : {}),
    ...(launch.linkedSkillsRoot ? { linkedSkillsRoot: launch.linkedSkillsRoot } : {})
  })
  return (connectionLaunch, handlers) =>
    sharedCodexServerPool().open(connectionLaunch, handlers ?? {}, {
      sessionId,
      skillRoots,
      codexVersion: launch.codexVersion ?? null
    })
}
