/** Reuse one wsl.exe for sequential stdin-free probes (~180ms startup each on win-lowspec). Isolate each sh command in its own session with /dev/null stdin; base64-frame output/status with per-loop markers. */
import { randomUUID } from 'node:crypto'
import { Duplex, PassThrough, Writable } from 'node:stream'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import type { RemoteCommandChannel } from '../managed-server/install/remote-install-transport'

// setsid preserves per-command process-group isolation. Fresh output files keep background writers attached to old inodes, never the next command.
export const WSL_COMMAND_LOOP_SCRIPT = [
  'm="$1"',
  'd=$(mktemp -d "${TMPDIR:-/tmp}/orca-wsl-exec.XXXXXX") || exit 97',
  'trap \'rm -rf "$d"\' EXIT',
  "trap 'exit 129' HUP INT TERM",
  '[ "$(printf eA== | base64 -d 2>/dev/null)" = x ] || exit 98',
  'if command -v setsid >/dev/null 2>&1; then s=setsid; else s=; fi',
  'printf \'%s R\\n\' "$m"',
  'while IFS= read -r l; do',
  '  c=$(printf %s "$l" | base64 -d) || exit 99',
  '  $s sh -c "$c" </dev/null >"$d/o" 2>"$d/e"',
  '  r=$?',
  '  printf \'%s O\\n\' "$m"; base64 <"$d/o"',
  '  printf \'%s E\\n\' "$m"; base64 <"$d/e"',
  '  printf \'%s X %s\\n\' "$m" "$r"',
  '  rm -f "$d/o" "$d/e"',
  'done'
].join('\n')

export const WSL_COMMAND_LOOP_ARGV0 = 'orca-wsl-exec-loop'

const BASE64_LINE = /^[A-Za-z0-9+/=]*$/u

type PendingCommand = {
  channel: Duplex
  stderr: PassThrough
  stdout: string[]
  errors: string[]
  section: 'none' | 'out' | 'err'
  settled: boolean
}

export type WslCommandLoop = {
  /** Resolves once the guest loop answered its self-test; rejects if it never can. */
  readonly ready: Promise<void>
  readonly busy: boolean
  readonly alive: boolean
  run(command: string): RemoteCommandChannel
  /** Ends the loop at its next read; a running command finishes first. */
  end(): void
  kill(): void
  onIdle(listener: () => void): void
}

export function wslCommandLoopMarker(): string {
  return `__ORCA_WSL_EXEC_${randomUUID().replaceAll('-', '')}__`
}

export function startWslCommandLoop(child: PipedChildProcess, marker: string): WslCommandLoop {
  let pending: PendingCommand | null = null
  let alive = true
  let buffered = ''
  let idleListener: () => void = () => {}
  let markReady: () => void = () => {}
  let failReady: (error: Error) => void = () => {}
  let isReady = false
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve
    failReady = reject
  })
  // Suppress unhandled readiness rejection when callers do not await it.
  ready.catch(() => {})

  const settle = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
    const command = pending
    if (!command || command.settled) {
      return
    }
    command.settled = true
    pending = null
    if (error) {
      command.channel.destroy(error)
    } else {
      const out = Buffer.from(command.stdout.join(''), 'base64')
      if (out.length > 0) {
        command.channel.push(out)
      }
      command.channel.push(null)
      const err = Buffer.from(command.errors.join(''), 'base64')
      command.stderr.end(err.length > 0 ? err : undefined)
    }
    command.channel.emit('exit', code, signal)
    // Emit close after streams drain, matching a direct wsl.exe child.
    setImmediate(() => command.channel.emit('close', code, signal))
    if (alive && !error) {
      idleListener()
    }
  }

  const fail = (reason: string): void => {
    if (!isReady) {
      failReady(new Error(reason))
    }
    settle(null, null, new Error(reason))
    if (alive) {
      kill()
    }
  }

  const onLine = (line: string): void => {
    if (line.startsWith(`${marker} `)) {
      const control = line.slice(marker.length + 1)
      if (control === 'R' && !isReady) {
        isReady = true
        markReady()
      } else if (control === 'O' && pending) {
        pending.section = 'out'
      } else if (control === 'E' && pending) {
        pending.section = 'err'
      } else if (control.startsWith('X ') && pending) {
        const code = Number.parseInt(control.slice(2), 10)
        settle(Number.isSafeInteger(code) ? code : null, null)
      } else {
        fail('The WSL command loop sent an unexpected frame')
      }
      return
    }
    if (!pending || pending.section === 'none') {
      // Ignore unframed stray guest output.
      return
    }
    if (!BASE64_LINE.test(line)) {
      fail('The WSL command loop sent a malformed frame')
      return
    }
    ;(pending.section === 'out' ? pending.stdout : pending.errors).push(line)
  }

  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      onLine(buffered.slice(0, newline).replace(/\r$/u, ''))
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  })
  // Drain loop-owned stderr so it cannot block wsl.exe; it belongs to no command.
  child.stderr.resume()
  const ignore = (): void => {}
  child.stdin.on('error', ignore)
  child.stdout.on('error', ignore)
  child.stderr.on('error', ignore)
  child.on('error', (error) => {
    alive = false
    fail(error.message)
  })
  child.on('close', (code, signal) => {
    alive = false
    if (!isReady) {
      failReady(new Error(`The WSL command loop exited (${code ?? signal ?? 'unknown'})`))
    }
    // A command cut off by the loop's exit reads like a killed wsl.exe child.
    settle(null, signal ?? 'SIGTERM')
  })

  return {
    ready,
    get busy() {
      return pending !== null
    },
    get alive() {
      return alive
    },
    run(command) {
      if (pending || !alive || !isReady) {
        throw new Error('The WSL command loop is not idle')
      }
      const stderr = new PassThrough()
      const channel = new Duplex({
        emitClose: false,
        read() {},
        write: refuseStdin
      })
      const entry: PendingCommand = {
        channel,
        stderr,
        stdout: [],
        errors: [],
        section: 'none',
        settled: false
      }
      pending = entry
      const commandChannel: RemoteCommandChannel = Object.assign(channel, {
        stdin: new Writable({ write: refuseStdin }),
        stderr,
        close: () => {
          // The command runs inside the loop, so stopping it means stopping the loop.
          if (!entry.settled) {
            kill()
          }
        }
      })
      child.stdin.write(`${Buffer.from(command, 'utf8').toString('base64')}\n`)
      return commandChannel
    },
    end() {
      if (alive) {
        child.stdin.end()
      }
    },
    kill,
    onIdle(listener) {
      idleListener = listener
    }
  }
}

function refuseStdin(_chunk: unknown, _encoding: unknown, done: (error?: Error) => void): void {
  done(new Error('This WSL command runs with stdin closed'))
}
