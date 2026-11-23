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

type CodexConnectionOpen = NonNullable<CodexStructuredSessionAdapterDeps['openConnection']>

const sharedOpeners = new WeakSet<CodexConnectionOpen>()

/** A shared server is many chats' process, so no one chat's recovery may ever signal it. */
export function opensSharedCodexServer(open: CodexConnectionOpen): boolean {
  return sharedOpeners.has(open)
}

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
  /** The chat's start: cancelled or superseded, or its Stop aborted the signal. */
  startup: { attempt?: { readonly cancelled: boolean }; signal?: AbortSignal | undefined } = {},
  platform: NodeJS.Platform = process.platform,
  windowsSharing: () => boolean = windowsSharedServersAvailable,
  pool: () => Pick<ReturnType<typeof sharedCodexServerPool>, 'open'> = sharedCodexServerPool
): CodexConnectionOpen {
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
  const open: CodexConnectionOpen = (connectionLaunch, handlers) =>
    pool()
      .open(connectionLaunch, handlers ?? {}, {
        sessionId,
        skillRoots,
        codexVersion: launch.codexVersion ?? null
      })
      .catch((error: unknown) => {
        // A chat nobody waits for any more gets no server of its own.
        const stopped = startup.attempt?.cancelled === true || startup.signal?.aborted === true
        if (error instanceof CodexSharedServerUncontainedError && !stopped) {
          // The chat's own server from here: recovery may signal it.
          sharedOpeners.delete(open)
          return spawnCodexAppServerConnection(connectionLaunch, handlers)
        }
        throw error
      })
  sharedOpeners.add(open)
  return open
}
