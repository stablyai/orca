// Decorate logged errors with a bounded redacted host tail, never telemetry; missing host evidence preserves the original failure.
import { redactString } from '../../observability/redactor'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { ORCAD_LOG_FILENAME } from './orcad-remote-host-support'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import {
  orcadWindowsSlotOpCommand,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'
import { ORCAD_WINDOWS_LOG_TAIL_MARKER } from '../host-state/orcad-windows-host-script'
import type { OrcadRemoteExecTarget } from './orcad-remote-runtime-control'

export const ORCAD_LOG_TAIL_LINES = 40
export const ORCAD_LOG_TAIL_MAX_BYTES = 8 * 1024
// Error decoration must not add an unbounded delay.
const ORCAD_LOG_TAIL_TIMEOUT_MS = 10_000

export function orcadLogTailCommand(host: RemoteHostPlatform, slotDir: string): string {
  const log = joinRemotePath(host, slotDir, ORCAD_LOG_FILENAME)
  if (isWindowsRemoteHost(host)) {
    return orcadWindowsSlotOpCommand(host, slotDir, 'log-tail', [
      log,
      String(ORCAD_LOG_TAIL_MAX_BYTES)
    ])
  }
  return `tail -c ${ORCAD_LOG_TAIL_MAX_BYTES} ${quotePosixShell(log)} 2>/dev/null || true`
}

export function parseOrcadLogTail(host: RemoteHostPlatform, output: string): string | null {
  const raw = isWindowsRemoteHost(host)
    ? (readOrcadWindowsEncodedAnswer(output, ORCAD_WINDOWS_LOG_TAIL_MARKER) ?? '')
    : output
  const bounded = Buffer.from(raw, 'utf8').subarray(-ORCAD_LOG_TAIL_MAX_BYTES).toString('utf8')
  const lines = bounded.replace(/\s+$/u, '').split(/\r?\n/u).slice(-ORCAD_LOG_TAIL_LINES)
  const tail = redactString(lines.join('\n'))
  return tail.trim() ? tail : null
}

async function readOrcadLogTail(
  target: OrcadRemoteExecTarget,
  slotDir: string
): Promise<string | null> {
  try {
    // Observe cancellation failures without reusing the already-aborted request signal.
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

export async function withOrcadLogTail(
  target: OrcadRemoteExecTarget,
  slotDir: string,
  message: string
): Promise<string> {
  const tail = await readOrcadLogTail(target, slotDir)
  return tail ? `${message}\nLast lines of orcad.log:\n${tail}` : message
}
