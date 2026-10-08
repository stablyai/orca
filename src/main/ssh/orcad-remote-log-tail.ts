/**
 * The end of a slot's orcad.log, appended to a failed deploy, launch or rollback so the error
 * says why orcad stopped rather than only where its log is. Errors and the main log only; never
 * telemetry. Best-effort: a host that can't answer leaves the error as it was.
 */
import { redactString } from '../observability/redactor'
import { shellEscape } from './ssh-connection-utils'
import { ORCAD_LOG_FILENAME } from './orcad-remote-host-support'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  orcadWindowsBaseDir,
  orcadWindowsHostOpCommand,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'
import { ORCAD_WINDOWS_LOG_TAIL_MARKER } from './orcad-windows-host-script'
import type { OrcadRemoteExecTarget } from './orcad-remote-runtime-control'

export const ORCAD_LOG_TAIL_LINES = 40
export const ORCAD_LOG_TAIL_MAX_BYTES = 8 * 1024
// Short, because it only decorates an error the caller already has.
const ORCAD_LOG_TAIL_TIMEOUT_MS = 10_000

export function orcadLogTailCommand(host: RemoteHostPlatform, slotDir: string): string {
  const log = joinRemotePath(host, slotDir, ORCAD_LOG_FILENAME)
  if (isWindowsRemoteHost(host)) {
    return orcadWindowsHostOpCommand(host, orcadWindowsBaseDir(host, slotDir), 'log-tail', [
      log,
      String(ORCAD_LOG_TAIL_MAX_BYTES)
    ])
  }
  return `tail -c ${ORCAD_LOG_TAIL_MAX_BYTES} ${shellEscape(log)} 2>/dev/null || true`
}

/** The last lines of what the host printed, redacted; null when the log is empty or absent. */
export function parseOrcadLogTail(host: RemoteHostPlatform, output: string): string | null {
  const raw = isWindowsRemoteHost(host)
    ? (readOrcadWindowsEncodedAnswer(output, ORCAD_WINDOWS_LOG_TAIL_MARKER) ?? '')
    : output
  const bounded = Buffer.from(raw, 'utf8').subarray(-ORCAD_LOG_TAIL_MAX_BYTES).toString('utf8')
  const lines = bounded.replace(/\s+$/u, '').split(/\r?\n/u).slice(-ORCAD_LOG_TAIL_LINES)
  const tail = redactString(lines.join('\n'))
  return tail.trim() ? tail : null
}

export async function readOrcadLogTail(
  target: OrcadRemoteExecTarget,
  slotDir: string
): Promise<string | null> {
  try {
    // No abort signal: the failure being reported may be the cancellation itself.
    const output = await execCommand(target.conn, orcadLogTailCommand(target.host, slotDir), {
      wrapCommand: target.host.commandDialect !== 'powershell',
      timeoutMs: ORCAD_LOG_TAIL_TIMEOUT_MS
    })
    return parseOrcadLogTail(target.host, output)
  } catch (error) {
    console.warn('[ssh] Could not read the orcad.log tail:', error)
    return null
  }
}

/** `message` followed by the log tail, or `message` alone when the host had none to give. */
export async function withOrcadLogTail(
  target: OrcadRemoteExecTarget,
  slotDir: string,
  message: string
): Promise<string> {
  const tail = await readOrcadLogTail(target, slotDir)
  return tail ? `${message}\nLast lines of orcad.log:\n${tail}` : message
}
