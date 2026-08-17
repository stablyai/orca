import { BrowserWindow } from 'electron'
import type { Store } from '../../../persistence'
import type { IPtyProvider } from '../../types'
import {
  HerdrCliHostTransport,
  herdrServerEnvironment,
  localHerdrCommand
} from './herdr-cli-session'
import { HerdrPtyProvider } from './herdr-pty-provider'
import {
  createHerdrPtyTargetResolver,
  createLocalHerdrPtyTargetResolver
} from './herdr-project-pty-target'
import type { SshConnection } from '../../../ssh/ssh-connection'
import type { RemoteHostPlatform } from '../../../ssh/ssh-remote-platform'
import { toSshExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  DEFAULT_HERDR_SESSION_NAME,
  normalizeHerdrBinarySource,
  type HerdrBinarySource
} from '../../../../shared/terminal-backend'
import { HerdrSshHostTransport } from './herdr-ssh-session'
import { HerdrSshRelayTransport } from './herdr-ssh-relay-transport'
import { HerdrSocketTransport } from './herdr-socket-transport'
import type { HerdrHostTransport } from './herdr-runtime-contract'
import { HerdrRuntimeError } from './herdr-runtime-contract'
import type { HerdrImportedSurface, HerdrOrcaSurfaceAction } from './herdr-orca-surface-import'

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
      } else {
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
  const transport = isUnixHost(hostPlatform)
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

type HerdrSettings = Pick<GlobalSettings, 'herdrBinarySource' | 'hostSettingOverrides'>

export function resolveHerdrBinarySource(
  settings: HerdrSettings,
  hostId: ExecutionHostId
): HerdrBinarySource {
  return normalizeHerdrBinarySource(
    settings.hostSettingOverrides?.[hostId]?.herdrBinarySource ?? settings.herdrBinarySource
  )
}

export function resolveHerdrExecutable(
  source: HerdrBinarySource,
  platform: NodeJS.Platform = process.platform
): string {
  if (source.kind === 'custom') {
    const customPath = source.path.trim()
    if (!customPath) {
      throw new HerdrRuntimeError('herdr_unavailable', 'Custom Herdr path is empty')
    }
    return customPath
  }
  return platform === 'win32' ? 'herdr.exe' : 'herdr'
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

function eachWindow(send: (contents: Electron.WebContents) => void): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      send(win.webContents)
    }
  }
}

export function presentHerdrImportedSurface(surface: HerdrImportedSurface): void {
  eachWindow((contents) => {
    contents.send('ui:createTerminal', {
      worktreeId: surface.worktreeId,
      ptyId: surface.ptyId,
      tabId: surface.tabId,
      leafId: surface.leafId,
      title: surface.title,
      ...(surface.cwd ? { cwd: surface.cwd } : {}),
      activate: false,
      focus: false,
      presentation: 'background',
      ...(surface.splitFromLeafId
        ? {
            splitFromLeafId: surface.splitFromLeafId,
            splitDirection: surface.splitDirection ?? 'vertical'
          }
        : {})
    })
  })
}

export function presentHerdrSurfaceAction(action: HerdrOrcaSurfaceAction): void {
  eachWindow((contents) => {
    if (action.kind === 'rename') {
      contents.send('ui:renameTerminal', { tabId: action.tabId, title: action.title })
      return
    }
    if (action.kind === 'focus') {
      contents.send('ui:focusTerminal', {
        tabId: action.tabId,
        worktreeId: action.worktreeId,
        leafId: action.leafId
      })
      return
    }
    if (action.kind === 'close') {
      contents.send('ui:closeTerminal', { tabId: action.tabId })
      return
    }
    contents.send('ui:applyTerminalLayout', { tabId: action.tabId, layout: action.layout })
  })
}
