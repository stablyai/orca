import {
  spawnCodexAppServerConnection,
  spawnRelayedCodexAppServerConnection
} from '../../app-server/codex-app-server-connection'
import { sharedCodexServerPool } from '../../app-server/shared-servers/codex-shared-server-pool'
import { CodexSharedServerUncontainedError } from '../../app-server/shared-servers/codex-shared-server-windows-job'
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

/** Off, a custom Codex command, or Windows: the chat spawns its own app-server (relayed on macOS
 *  and Linux). On: it leases a thread on a shared one. Windows can't tell one chat's processes from
 *  another's under a shared server, so its Stop couldn't prove the chat's commands ended. */
export function codexConnectionOpener(
  deps: Pick<CodexStructuredSessionAdapterDeps, 'openConnection' | 'sharedServers'>,
  sessionId: string,
  launch: Pick<
    CodexStructuredLaunch,
    'visuals' | 'linkedSkillsRoot' | 'codexVersion' | 'customCommand' | 'appBoundGrants'
  >,
  /** The chat's start: cancelled or superseded, or its Stop aborted the signal. */
  startup: { attempt?: { readonly cancelled: boolean }; signal?: AbortSignal | undefined } = {},
  platform: NodeJS.Platform = process.platform,
  pool: () => Pick<ReturnType<typeof sharedCodexServerPool>, 'open'> = sharedCodexServerPool
): CodexConnectionOpen {
  if (deps.openConnection) {
    return deps.openConnection
  }
  // A chat's own app-server runs under the terminal daemon where it can, so it survives a restart.
  // Windows launches its own as always, and so does a bot's chat: its grants end with this app.
  if (launch.customCommand || platform === 'win32' || deps.sharedServers?.() !== true) {
    return platform === 'win32' || launch.appBoundGrants
      ? spawnCodexAppServerConnection
      : spawnRelayedCodexAppServerConnection(sessionId)
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
