import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { getMacBundleIdentifier } from './macos-bundle-identifier'

/** Stdin EOF tells the wrapper that Orca died. */
export type LogStreamChild = ChildProcessByStdio<Writable, Readable, Readable>

// AUTHREQ_PROMPTING identifies actual dialogs, including access attributed to Orca’s terminal children (#9756).

// Derived from the running bundle so each channel or renamed build matches itself; TCC attributes the detached helper separately.
function isOwnResponsibleIdentifier(identifier: string, ownIdentifier: string | null): boolean {
  return (
    ownIdentifier !== null &&
    (identifier === ownIdentifier || identifier === `${ownIdentifier}.helper`)
  )
}

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

export function isOwnAttributedPrompt(
  event: TccPromptEvent,
  ownIdentifier: string | null = getMacBundleIdentifier()
): boolean {
  return (
    isOwnResponsibleIdentifier(event.responsibleIdentifier, ownIdentifier) &&
    WATCHED_SERVICES.has(event.service)
  )
}

export type TccPromptWatchOptions = {
  onPrompt: (event: TccPromptEvent) => void
  spawnLogStream?: () => LogStreamChild
  restartDelayMs?: number
  /** Injected in tests; production reads the running bundle's own identifier. */
  ownIdentifier?: string | null
}

// log stream ignores parent death; stdin EOF makes the wrapper terminate it.
// Preserve stdin on fd 3 because sh backgrounds async lists with /dev/null; arm the trap before forking.
// Disable inherited errexit/nounset so EOF and early signals still reach cleanup.
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
    const own = this.options.ownIdentifier ?? getMacBundleIdentifier()
    if (!event || !isOwnAttributedPrompt(event, own)) {
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
    // Closing stdout does not stop log stream; terminate it explicitly.
    this.child?.kill('SIGTERM')
    this.child?.stdin.destroy()
    this.child = null
  }
}
