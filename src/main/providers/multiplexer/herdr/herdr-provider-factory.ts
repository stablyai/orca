import type { Store } from '../../../persistence'
import type { IPtyProvider } from '../../types'
import { HerdrCliHostTransport, localHerdrCommand } from './herdr-cli-host-transport'
import { HerdrPtyProvider } from './herdr-pty-provider'
import {
  createHerdrPtyTargetResolver,
  createLocalHerdrPtyTargetResolver
} from './herdr-project-pty-target'
import type { SshConnection } from '../../../ssh/ssh-connection'
import type { RemoteHostPlatform } from '../../../ssh/ssh-remote-platform'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { HerdrSshHostTransport } from './herdr-ssh-host-transport'
import { HerdrSshRelayTransport } from './herdr-ssh-relay-transport'
import { HerdrSocketTransport } from './herdr-socket-transport'
import { HerdrDaemonHostTransport } from './herdr-daemon-host-transport'
import { herdrServerEnvironment } from './herdr-session-process'
import { resolveHerdrBinarySource, resolveHerdrExecutable } from './herdr-binary-source'
import type { HerdrHostTransport } from './herdr-runtime-contract'
import { DEFAULT_HERDR_SESSION_NAME } from './herdr-transport-factory'
import {
  presentHerdrImportedSurface,
  presentHerdrSurfaceAction
} from './herdr-orca-surface-present'
import type { HerdrImportedSurface } from './herdr-orca-surface-import'

export type HerdrLocalTransportKind = 'socket' | 'cli'

// Socket is the default local transport: it is the only path that exposes the
// full protocol-19 surface (events, layout apply, live handoff, screen
// history). HERDR_LOCAL_TRANSPORT=cli forces the legacy CLI transport; WSL and
// SSH hosts keep their existing transports.
function resolveLocalTransportKind(): HerdrLocalTransportKind {
  return process.env.HERDR_LOCAL_TRANSPORT === 'cli' ? 'cli' : 'socket'
}

export function createLocalHerdrPtyProvider(
  _fallback: IPtyProvider | undefined,
  store: Store
): HerdrPtyProvider {
  const transports = new Map<string, HerdrHostTransport>()
  return new HerdrPtyProvider(
    (target) => {
      const hostId = target.identity.hostId
      let transport = transports.get(hostId)
      if (transport) {
        return transport
      }
      const source = resolveHerdrBinarySource(store.getSettings(), 'local')
      const wslDistro = parseWslHostId(hostId)
      if (wslDistro) {
        const executable = resolveHerdrExecutable(source, 'linux')
        transport = new HerdrCliHostTransport({
          commandFor: (args) => ({
            file: 'wsl.exe',
            args: ['-d', wslDistro, '--', executable, ...args]
          }),
          serverCommandFor: (sessionName) => {
            const envKeysToRemove = Object.keys(process.env).filter((k) => k.startsWith('HERDR_'))
            return {
              file: 'wsl.exe',
              args: [
                '-d',
                wslDistro,
                '--',
                'env',
                ...envKeysToRemove.flatMap((k) => ['-u', k]),
                executable,
                '--session',
                sessionName,
                'server'
              ]
            }
          }
        })
      } else if (store.getSettings().herdrRuntimeSource === 'daemon') {
        transport = new HerdrDaemonHostTransport()
      } else if (resolveLocalTransportKind() === 'socket') {
        const executable = resolveHerdrExecutable(source)
        transport = new HerdrSocketTransport({
          sessionName: store.getSettings().herdrSessionName ?? DEFAULT_HERDR_SESSION_NAME,
          commandFor: localHerdrCommand(executable),
          serverCommandFor: (sessionName) => ({
            file: executable,
            args: ['--session', sessionName, 'server'],
            // Why: strip HERDR_* so a server spawned from inside a stock herdr
            // session binds the named session, not the parent session's socket.
            env: herdrServerEnvironment(undefined)
          })
        })
      } else {
        const executable = resolveHerdrExecutable(source)
        transport = new HerdrCliHostTransport({
          commandFor: localHerdrCommand(executable)
        })
      }
      transports.set(hostId, transport)
      return transport
    },
    createLocalHerdrPtyTargetResolver(store),
    () => store.getSettings().herdrSessionName,
    {
      persist: (surface: HerdrImportedSurface) => {
        store.persistPtyBinding({
          worktreeId: surface.worktreeId,
          tabId: surface.tabId,
          leafId: surface.leafId,
          ptyId: surface.ptyId,
          ...(surface.cwd ? { startupCwd: surface.cwd } : {})
        })
      },
      present: presentHerdrImportedSurface,
      presentAction: presentHerdrSurfaceAction
    }
  )
}

export function createSshHerdrPtyProvider(
  _fallback: IPtyProvider | undefined,
  store: Store,
  connection: SshConnection,
  targetId: string,
  hostPlatform?: RemoteHostPlatform
): HerdrPtyProvider {
  const source = resolveHerdrBinarySource(store.getSettings(), toSshExecutionHostId(targetId))
  const executable = async () => resolveHerdrExecutable(source, hostPlatform?.os ?? 'linux')

  // Why: when the herdr backend is active, use the daemon-to-daemon relay
  // (full protocol-19 over SSH tunnel) instead of CLI exec (one-shot commands).
  // Fallback to CLI transport for legacy or incompatible SSH servers.
  const transport =
    store.getSettings().terminalBackendDefault === 'herdr' && isUnixHost(hostPlatform)
      ? new HerdrSshRelayTransport(connection, 15_000, executable, hostPlatform)
      : new HerdrSshHostTransport(connection, 15_000, executable, hostPlatform)

  return new HerdrPtyProvider(
    () => transport,
    createHerdrPtyTargetResolver(store, toSshExecutionHostId(targetId)),
    () => store.getSettings().herdrSessionName,
    {
      persist: (surface: HerdrImportedSurface) => {
        store.persistPtyBinding({
          worktreeId: surface.worktreeId,
          tabId: surface.tabId,
          leafId: surface.leafId,
          ptyId: surface.ptyId,
          ...(surface.cwd ? { startupCwd: surface.cwd } : {})
        })
      }
    }
  )
}

function isUnixHost(platform?: RemoteHostPlatform): boolean {
  if (!platform) {
    return true
  }
  return platform.os !== 'win32'
}

function parseWslHostId(hostId: string): string | null {
  if (!hostId.startsWith('wsl:')) {
    return null
  }
  try {
    const distro = decodeURIComponent(hostId.slice('wsl:'.length))
    return distro || null
  } catch {
    return null
  }
}
