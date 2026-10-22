/** Which command runs the stdio bridge on a host, and whether it can run there at all. */
import {
  OrcadHostUnsupportedError,
  OrcadStdioBridgeUnavailableError
} from '../orcad/orcad-host-unavailable'
import { resolveOrcadRemoteContext } from '../managed-server/install/orcad-remote-context'
import { orcadWindowsHomeOpCommand } from '../managed-server/install/orcad-remote-windows-node'
import {
  orcadPosixStdioBridgeCommand,
  type OrcadStdioBridgeMode
} from '../managed-server/lifecycle/orcad-stdio-bridge-script'
import {
  OrcadStdioBridgeDecoder,
  type OrcadStdioBridgeSignal
} from '../managed-server/lifecycle/orcad-stdio-bridge-stream'
import { isWslOrcadHostTarget, type OrcadHostTransport } from './orcad-host-transport'
import type { RemoteCommandChannel } from '../managed-server/install/remote-install-transport'
import { isWindowsRemoteHost } from './ssh-remote-platform'
import { detectRemoteHostPlatform } from './ssh-remote-platform-detection'

export type OrcadStdioBridge = {
  command: string
  mode: OrcadStdioBridgeMode
  wrapCommand: boolean
}

const ORCAD_STDIO_BRIDGE_CHECK_TIMEOUT_MS = 20_000
const MAX_STDERR_TAIL_CHARS = 2_000
// POSIX shells and cmd.exe report a command they cannot find with these.
const COMMAND_NOT_FOUND_EXITS: ReadonlySet<number | null> = new Set([127, 9009])

export async function resolveOrcadStdioBridge(
  conn: OrcadHostTransport,
  port: number
): Promise<OrcadStdioBridge> {
  // A WSL distro is always a POSIX host, and its deploy already proved Linux: skip the round trip.
  if (isWslOrcadHostTarget(conn.getTarget())) {
    return { command: orcadPosixStdioBridgeCommand(port), mode: 'raw', wrapCommand: true }
  }
  const host = await detectRemoteHostPlatform(conn)
  if (!host) {
    throw new OrcadHostUnsupportedError('Orca’s server doesn’t support this SSH host’s platform.')
  }
  if (!isWindowsRemoteHost(host)) {
    return { command: orcadPosixStdioBridgeCommand(port), mode: 'raw', wrapCommand: true }
  }
  const target = conn.getTarget()
  // Stages this client's pinned node.exe and host script, which an app update may have changed.
  const context = await resolveOrcadRemoteContext(target, conn, undefined, host)
  return {
    command: orcadWindowsHomeOpCommand(host, context.remoteHome, 'stdio-bridge', [String(port)]),
    mode: 'base64',
    wrapCommand: host.commandDialect !== 'powershell'
  }
}

export function openOrcadStdioBridgeChannel(
  conn: OrcadHostTransport,
  bridge: OrcadStdioBridge
): Promise<RemoteCommandChannel> {
  return conn.exec(bridge.command, { wrapCommand: bridge.wrapCommand })
}

function closeQuietly(channel: RemoteCommandChannel): void {
  try {
    channel.close()
  } catch {
    // Already closed.
  }
}

/**
 * Runs the bridge once. Any sentinel proves it runs, even when orcad's port refused it. Only an
 * exit the host reported without one is proof it can't run; anything else is unverifiable.
 */
export async function checkOrcadStdioBridge(
  conn: OrcadHostTransport,
  bridge: OrcadStdioBridge,
  timeoutMs = ORCAD_STDIO_BRIDGE_CHECK_TIMEOUT_MS
): Promise<'running' | 'unverifiable'> {
  let channel: RemoteCommandChannel
  try {
    channel = await openOrcadStdioBridgeChannel(conn, bridge)
  } catch {
    return 'unverifiable'
  }
  const decoder = new OrcadStdioBridgeDecoder(bridge.mode)
  let stderr = ''
  let exitCode: number | null = null
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => settle('unverifiable'), timeoutMs)
    function settle(verdict: 'running' | 'unverifiable' | Error): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      closeQuietly(channel)
      decoder.destroy()
      if (verdict instanceof Error) {
        reject(verdict)
      } else {
        resolve(verdict)
      }
    }
    const unavailable = (detail: string): Error =>
      new OrcadStdioBridgeUnavailableError(
        `The SSH host could not run the stdio bridge for this host’s Orca server: ${detail}`
      )
    decoder.on('signal', (signal: OrcadStdioBridgeSignal) => {
      settle(signal === 'no-node' ? unavailable('no pinned Node runtime') : 'running')
    })
    decoder.on('error', () => settle('unverifiable'))
    decoder.resume()
    channel.pipe(decoder)
    channel.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_TAIL_CHARS)
    })
    channel.on('exit', (code: unknown) => {
      exitCode = typeof code === 'number' ? code : null
    })
    channel.on('close', () => {
      // Why only command-not-found: a lost channel, or a script cut short (a concurrent host-script
      // write, a killed node.exe), proves nothing permanent about the host.
      settle(
        COMMAND_NOT_FOUND_EXITS.has(exitCode)
          ? unavailable(`exit ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
          : 'unverifiable'
      )
    })
    channel.on('error', () => settle('unverifiable'))
  })
}
