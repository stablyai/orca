/** Which command runs the stdio bridge on a host, and whether it can run there at all. */
import type { ClientChannel } from 'ssh2'
import {
  OrcadHostUnsupportedError,
  OrcadStdioBridgeUnavailableError
} from './orcad-host-unavailable'
import { resolveOrcadRemoteContext } from './orcad-remote-context'
import { orcadRemoteBaseDir, orcadWindowsHostOpCommand } from './orcad-remote-windows-node'
import {
  orcadPosixStdioBridgeCommand,
  type OrcadStdioBridgeMode
} from './orcad-stdio-bridge-script'
import { OrcadStdioBridgeDecoder, type OrcadStdioBridgeSignal } from './orcad-stdio-bridge-stream'
import type { SshConnection } from './ssh-connection'
import { isWindowsRemoteHost } from './ssh-remote-platform'
import { detectRemoteHostPlatform } from './ssh-remote-platform-detection'

export type OrcadStdioBridge = {
  command: string
  mode: OrcadStdioBridgeMode
  wrapCommand: boolean
}

export const ORCAD_STDIO_BRIDGE_CHECK_TIMEOUT_MS = 20_000
const MAX_STDERR_TAIL_CHARS = 2_000
// POSIX shells and cmd.exe report a command they cannot find with these.
const COMMAND_NOT_FOUND_EXITS: ReadonlySet<number | null> = new Set([127, 9009])

export async function resolveOrcadStdioBridge(
  conn: SshConnection,
  port: number
): Promise<OrcadStdioBridge> {
  const host = await detectRemoteHostPlatform(conn)
  if (!host) {
    throw new OrcadHostUnsupportedError('This SSH host platform is not supported by managed orcad.')
  }
  if (!isWindowsRemoteHost(host)) {
    return { command: orcadPosixStdioBridgeCommand(port), mode: 'raw', wrapCommand: true }
  }
  // Stages this client's pinned node.exe and host script, which an app update may have changed.
  const context = await resolveOrcadRemoteContext(conn.getTarget(), conn, undefined, host)
  return {
    command: orcadWindowsHostOpCommand(
      host,
      orcadRemoteBaseDir(host, context.remoteHome),
      'stdio-bridge',
      [String(port)]
    ),
    mode: 'base64',
    wrapCommand: host.commandDialect !== 'powershell'
  }
}

export function openOrcadStdioBridgeChannel(
  conn: SshConnection,
  bridge: OrcadStdioBridge
): Promise<ClientChannel> {
  return conn.exec(bridge.command, { wrapCommand: bridge.wrapCommand })
}

function closeQuietly(channel: ClientChannel): void {
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
  conn: SshConnection,
  bridge: OrcadStdioBridge,
  timeoutMs = ORCAD_STDIO_BRIDGE_CHECK_TIMEOUT_MS
): Promise<'running' | 'unverifiable'> {
  let channel: ClientChannel
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
        `The SSH host could not run the managed Orca server's stdio bridge: ${detail}`
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
