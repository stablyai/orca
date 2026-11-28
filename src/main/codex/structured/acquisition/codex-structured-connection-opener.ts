import {
  spawnCodexAppServerConnection,
  spawnRelayedCodexAppServerConnection
} from '../../app-server/codex-app-server-connection'
import { sharedCodexServerPool } from '../../app-server/shared-servers/codex-shared-server-pool'
import { CodexSharedServerUncontainedError } from '../../app-server/shared-servers/codex-shared-server-windows-job'
import { codexSkillRoots } from '../launch/codex-structured-skill-roots'
import { takeProviderRelayHandedBack } from '../../../provider-relay/app-provider-relays'
import { providerRelayRunGate } from '../../../provider-relay/provider-relay-run-liveness'
import { providerRelayPlacedRunOf } from '../../../provider-relay/provider-relay-placed-records'
import { codexPooledRunOf } from '../../app-server/shared-servers/codex-shared-server-kept-runs'
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
  const own =
    platform === 'win32' || launch.appBoundGrants
      ? spawnCodexAppServerConnection
      : spawnRelayedCodexAppServerConnection({ chatKey: sessionId })
  // A run kept on a shared server is reattached there whatever the setting says now.
  const pooledRun = platform !== 'win32' && codexPooledRunOf(sessionId) !== null
  // A chat's own app-server runs under the terminal daemon where it can, so it survives a restart.
  // Windows launches its own as always, and so does a bot's chat: its grants end with this app.
  const pooled = !launch.customCommand && platform !== 'win32' && deps.sharedServers?.() === true
  if (!pooledRun && !pooled) {
    return own
  }
  const skillRoots = codexSkillRoots({
    ...(launch.visuals ? { visualsSkillsRoot: launch.visuals.skill.skillsRoot } : {}),
    ...(launch.linkedSkillsRoot ? { linkedSkillsRoot: launch.linkedSkillsRoot } : {})
  })
  const open: CodexConnectionOpen = async (connectionLaunch, handlers) => {
    // A chat's own agent kept from its last run is reattached as its own, never beside a pooled one;
    // a pooled run that ended lets a chat no longer pooled start its own.
    const ownNext = pooledRun
      ? !pooled && (await providerRelayRunGate(sessionId, 'gone')) === 'gone'
      : await ownRunMayBeKept(sessionId)
    if (ownNext) {
      sharedOpeners.delete(open)
      return own(connectionLaunch, handlers)
    }
    // A pooled launch retires a hand-back's exemption, as a relayed one does.
    takeProviderRelayHandedBack(sessionId)
    return pool()
      .open(connectionLaunch, handlers ?? {}, {
        sessionId,
        skillRoots,
        codexVersion: launch.codexVersion ?? null,
        // PR A gives bot chats tools that outlive the app; until then a bot's run ends with it.
        keepable: !launch.appBoundGrants
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
  }
  sharedOpeners.add(open)
  return open
}

/** The chat's last run was its own relayed agent, and only a gone verdict lets a pool replace it. */
async function ownRunMayBeKept(sessionId: string): Promise<boolean> {
  const run = providerRelayPlacedRunOf(sessionId)
  return run !== null && (await providerRelayRunGate(sessionId, 'gone')) !== 'gone'
}
