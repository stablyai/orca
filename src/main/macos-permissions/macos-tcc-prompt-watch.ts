import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

/** Stdin EOF tells the wrapper that Orca died. */
export type LogStreamChild = ChildProcessByStdio<Writable, Readable, Readable>

// AUTHREQ_PROMPTING identifies actual dialogs, including access attributed to Orca’s terminal children (#9756).

// TCC can attribute terminal access to the detached helper independently of the main app.
const ORCA_RESPONSIBLE_IDENTIFIERS = new Set([
  'com.stablyai.orca',
  'com.stablyai.orca.helper',
  'com.stablyai.orca.dev',
  'com.stablyai.orca.dev.helper',
  'com.stablyai.orca.local',
  'com.stablyai.orca.local.helper'
])

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
  service: string
  /** Bundle ID or hashed identity of the process performing the access. */
  accessingIdentifier: string
  /** Bundle ID named as responsible in the dialog. */
  responsibleIdentifier: string
  binaryPath?: string
}

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

export function isOrcaAttributedPrompt(event: TccPromptEvent): boolean {
  return (
    ORCA_RESPONSIBLE_IDENTIFIERS.has(event.responsibleIdentifier) &&
    WATCHED_SERVICES.has(event.service)
  )
}

export type TccPromptWatchOptions = {
  onPrompt: (event: TccPromptEvent) => void
  spawnLogStream?: () => LogStreamChild
  restartDelayMs?: number
}

// log stream ignores parent death; stdin EOF makes the single wrapper shell terminate it.
// Redirect the wrapper's stdout to /dev/null after handing the pipe to log stream so log exit triggers stdout EOF in main.
// Disable inherited errexit/nounset so EOF and early signals still reach cleanup.
const LOG_STREAM_WRAPPER_SCRIPT = `set +eu
exec 4>&1 >/dev/null
log_pid=
term=
trap 'term=1; [ -n "$log_pid" ] && kill "$log_pid" 2>/dev/null' TERM INT HUP
/usr/bin/log stream --predicate "$1" --info --style compact </dev/null >&4 4>&- &
log_pid=$!
exec 4>&-
if [ -n "$term" ]; then
  kill "$log_pid" 2>/dev/null
else
  read -r _
  kill "$log_pid" 2>/dev/null
fi
# A kill landing in log's fork-to-exec window is dropped; re-kill after the window closes.
# log_pid is unreaped (wait comes after), so it cannot be recycled.
sleep 0.2
kill "$log_pid" 2>/dev/null
wait "$log_pid"
exit "$?"`

function spawnDefaultLogStream(): LogStreamChild {
  // Filter within logd to avoid streaming routine TCC traffic into main.
  return spawn('/bin/sh', ['-c', LOG_STREAM_WRAPPER_SCRIPT, 'sh', LOG_PREDICATE], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

/** start() is a no-op outside macOS. */
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
      // Optional diagnostics must not prevent startup if log is unavailable.
      return
    }
    this.child = child
    child.on('error', () => this.handleUnexpectedTermination(child))
    child.on('exit', () => this.handleUnexpectedTermination(child))
    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', (line) => this.handleLine(line))
    // Single-shell wrapper closes its own stdout after spawning log stream, so stdout EOF signals log exit.
    this.reader.on('close', () => this.handleUnexpectedTermination(child))
  }

  private handleUnexpectedTermination(child: LogStreamChild): void {
    if (this.child !== child) {
      return
    }
    this.reader?.close()
    this.reader = null
    this.child = null
    // EOF makes any surviving wrapper reader terminate its log stream.
    child.stdin.destroy()
    if (this.stopped || this.restartAttempted) {
      return
    }
    this.restartAttempted = true
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
    const child = this.child
    this.child = null
    this.reader?.close()
    this.reader = null
    // Closing stdout does not stop log stream; terminate it explicitly.
    child?.kill('SIGTERM')
    child?.stdin.destroy()
  }
}
