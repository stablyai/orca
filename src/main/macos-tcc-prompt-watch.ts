import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

/** Why: stdin is a never-written pipe whose EOF tells the wrapper that Orca died. */
export type LogStreamChild = ChildProcessByStdio<Writable, Readable, Readable>

/**
 * Counts the macOS TCC consent dialogs that name Orca as the responsible
 * process (#9756). Terminal children — agent CLIs and anything else the user
 * runs — perform the access, but TCC walks the responsibility chain back to
 * Orca and puts Orca's name on the dialog, so users read it as Orca snooping.
 *
 * tccd emits one `AUTHREQ_PROMPTING` line per dialog it actually displays,
 * carrying the service and both identities, so this never has to correlate
 * across lines or guess whether a dialog was shown. Routine preflight checks
 * (the overwhelming majority of TCC log traffic) do not emit it.
 */

/** Why: terminals run from the detached helper, which TCC can hold responsible independently. */
const ORCA_RESPONSIBLE_IDENTIFIERS = new Set([
  'com.stablyai.orca',
  'com.stablyai.orca.helper',
  'com.stablyai.orca.dev',
  'com.stablyai.orca.dev.helper',
  'com.stablyai.orca.local',
  'com.stablyai.orca.local.helper'
])

/** Why: the prompt classes #9756 is about — other-apps' data plus the protected home folders agents sweep. */
const WATCHED_SERVICES = new Set([
  'kTCCServiceSystemPolicyAppData',
  'kTCCServiceSystemPolicyAllFiles',
  'kTCCServiceSystemPolicyDocumentsFolder',
  'kTCCServiceSystemPolicyDesktopFolder',
  'kTCCServiceSystemPolicyDownloadsFolder'
])

export const LOG_PREDICATE =
  'subsystem == "com.apple.TCC" AND eventMessage CONTAINS "AUTHREQ_PROMPTING"'

export type TccPromptEvent = {
  /** TCC service the dialog was raised for, e.g. `kTCCServiceSystemPolicyAppData`. */
  service: string
  /** Bundle id or hashed identity of the process performing the access (often an agent CLI). */
  accessingIdentifier: string
  /** Bundle id macOS holds responsible, and therefore names in the dialog. */
  responsibleIdentifier: string
  /** Absolute path of the accessing binary, when tccd reports one. */
  binaryPath?: string
}

/**
 * Parses one `AUTHREQ_PROMPTING` log line. Returns null for anything else, so
 * callers can feed the raw stream (which includes a header line) straight in.
 */
export function parseTccPromptEvent(line: string): TccPromptEvent | null {
  if (!line.includes('AUTHREQ_PROMPTING')) {
    return null
  }
  const service = /\bservice=(kTCCService\w+)/.exec(line)?.[1]
  const accessingIdentifier = /\bSub:\{([^}]*)\}/.exec(line)?.[1]
  const responsibleIdentifier = /\bResp:\{TCCDProcess:\s*identifier=([^,}]+)/.exec(line)?.[1]
  if (!service || !accessingIdentifier || !responsibleIdentifier) {
    return null
  }
  const binaryPath = /\bbinary_path=([^,}]+)/.exec(line)?.[1]
  return {
    service,
    accessingIdentifier: accessingIdentifier.trim(),
    responsibleIdentifier: responsibleIdentifier.trim(),
    ...(binaryPath ? { binaryPath: binaryPath.trim() } : {})
  }
}

/** True when this dialog is one macOS raised in Orca's name for a watched file-access service. */
export function isOrcaAttributedPrompt(event: TccPromptEvent): boolean {
  return (
    ORCA_RESPONSIBLE_IDENTIFIERS.has(event.responsibleIdentifier) &&
    WATCHED_SERVICES.has(event.service)
  )
}

export type TccPromptWatchOptions = {
  onPrompt: (event: TccPromptEvent) => void
  /** Injected in tests; defaults to spawning `log stream`. */
  spawnLogStream?: () => LogStreamChild
  /** Injected in tests; production waits before its single recovery attempt. */
  restartDelayMs?: number
}

// Why: `log stream` never notices its parent dying (it only writes on a rare
// match), so a crashed or SIGKILLed Orca orphaned it forever. The wrapper kills
// it when our stdin pipe hits EOF, and exits when it exits. fd 3 is needed
// because async lists in a non-interactive sh get stdin=/dev/null. The trap is
// armed before the fork; `term` covers a signal that lands before `log_pid` is set.
// `set +eu` because an inherited SHELLOPTS=errexit would end the reader on read's EOF status.
const LOG_STREAM_WRAPPER_SCRIPT = `set +eu
exec 3<&0
log_pid=
term=
trap 'term=1; [ -n "$log_pid" ] && kill "$log_pid" 2>/dev/null' TERM INT HUP
/usr/bin/log stream --predicate "$1" --info --style compact </dev/null 3<&- &
log_pid=$!
[ -n "$term" ] && kill "$log_pid" 2>/dev/null
{ read -r _ <&3; kill "$log_pid" 2>/dev/null; } &
reader_pid=$!
wait "$log_pid"
status=$?
kill "$reader_pid" 2>/dev/null
exit "$status"`

function spawnDefaultLogStream(): LogStreamChild {
  // Why: the predicate is evaluated inside the logging system, so this delivers
  // ~1 line per real dialog instead of the ~30/s the TCC subsystem emits raw.
  return spawn('/bin/sh', ['-c', LOG_STREAM_WRAPPER_SCRIPT, 'sh', LOG_PREDICATE], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

/**
 * Watches for Orca-attributed TCC dialogs. macOS-only; `start()` is a no-op
 * elsewhere so callers don't need their own platform guard.
 */
export class MacosTccPromptWatch {
  private child: LogStreamChild | null = null
  private reader: Interface | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempted = false
  private stopped = false

  constructor(private readonly options: TccPromptWatchOptions) {}

  start(): void {
    if (process.platform !== 'darwin' || this.child || this.stopped) {
      return
    }
    const spawnLogStream = this.options.spawnLogStream ?? spawnDefaultLogStream
    let child: LogStreamChild
    try {
      child = spawnLogStream()
    } catch {
      // Why: diagnostics only — a missing or restricted `log` binary must never
      // break startup, and there is nothing actionable to tell the user.
      return
    }
    this.child = child
    child.on('error', () => this.handleUnexpectedTermination(child))
    child.on('exit', () => this.handleUnexpectedTermination(child))
    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', (line) => this.handleLine(line))
  }

  private handleUnexpectedTermination(child: LogStreamChild): void {
    if (this.child !== child) {
      return
    }
    this.reader?.close()
    this.reader = null
    this.child = null
    // Why: EOF on stdin makes any surviving wrapper reader kill its log stream.
    child.stdin.destroy()
    if (this.stopped || this.restartAttempted) {
      return
    }
    this.restartAttempted = true
    // Why: recover one transient logd failure without respawning forever when logging is unavailable.
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, this.options.restartDelayMs ?? 1_000)
  }

  private handleLine(line: string): void {
    const event = parseTccPromptEvent(line)
    if (!event || !isOrcaAttributedPrompt(event)) {
      return
    }
    this.options.onPrompt(event)
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.reader?.close()
    this.reader = null
    // Why: log stream ignores a closed stdout, so the child needs an explicit kill or it outlives quit.
    this.child?.kill('SIGTERM')
    this.child?.stdin.destroy()
    this.child = null
  }
}
