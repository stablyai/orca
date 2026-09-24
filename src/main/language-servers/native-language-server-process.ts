// Native-host language-server process adapter (spec D8: local host goes
// through spawnProcess — never node:child_process directly; the ratchet test
// enforces it). Shape follows codex-app-server-connection.ts: injectable
// spawnImpl for tests, bounded stderr tail, tree-kill teardown ladder.
import { spawnProcess } from '../../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'

export type NativeLanguageServerLaunch = {
  program: string
  args: readonly string[]
  cwd: string
}

export type NativeLanguageServerProcessHandlers = {
  onStdoutChunk: (chunk: Buffer) => void
  onStderrLine: (line: string) => void
  /** Terminal and fired exactly once: spawn error, protocol death or clean exit. */
  onExit: (error: Error | null) => void
}

export type NativeLanguageServerProcess = {
  readonly pid: number | undefined
  readonly exited: Promise<boolean>
  write(bytes: Buffer): void
  /** Close stdin — the polite half of the shutdown ladder. */
  endStdin(): void
  /** Force the whole tree down; resolves once termination is proven or abandoned. */
  killTree(): Promise<boolean>
}

const STDERR_TAIL_MAX_LINES = 500
const GRACEFUL_EXIT_MS = 5_000
const FORCED_EXIT_MS = 5_000

/** Line-buffers stderr so half-line writes never garble the log tail. */
function createStderrLineBuffer(onLine: (line: string) => void): (chunk: string) => void {
  let carry = ''
  const tail: string[] = []
  return (chunk: string) => {
    carry += chunk
    const lines = carry.split(/\r?\n/)
    carry = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) {
        continue
      }
      tail.push(line)
      if (tail.length > STDERR_TAIL_MAX_LINES) {
        tail.shift()
      }
      onLine(line)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function openNativeLanguageServerProcess(
  launch: NativeLanguageServerLaunch,
  handlers: NativeLanguageServerProcessHandlers,
  spawnImpl: typeof spawnProcess = spawnProcess
): NativeLanguageServerProcess {
  const child = spawnImpl({
    program: launch.program,
    args: launch.args,
    cwd: launch.cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let exited = false
  let exitReported = false
  let firstTerminalError: Error | null = null
  let resolveExited: (proven: boolean) => void
  const exitedPromise = new Promise<boolean>((resolve) => {
    resolveExited = resolve
  })

  const observeExit = (error: Error | null): void => {
    exited = true
    if (!exitReported) {
      exitReported = true
      handlers.onExit(error)
    }
    resolveExited(true)
  }

  child.on('exit', () => {
    observeExit(firstTerminalError)
  })
  child.on('error', (error) => {
    // First cause wins: a child that dies reaches us through several listeners.
    if (!firstTerminalError) {
      firstTerminalError = error
    }
    if (exited) {
      observeExit(firstTerminalError)
    }
  })
  child.on('close', () => {
    observeExit(firstTerminalError)
  })

  const bufferStderrLine = createStderrLineBuffer(handlers.onStderrLine)
  child.stdout.on('data', (chunk: Buffer) => handlers.onStdoutChunk(chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => bufferStderrLine(chunk))
  // Why a no-op listener: an unhandled stream error is an uncaught exception
  // that takes the main process down; EPIPE during teardown must stay benign.
  child.stdin.on('error', () => {})

  return {
    get pid(): number | undefined {
      return child.pid
    },
    exited: exitedPromise,
    write(bytes: Buffer): void {
      child.stdin.write(bytes)
    },
    endStdin(): void {
      try {
        child.stdin.end()
      } catch {
        // Already destroyed; the exit ladder still runs.
      }
    },
    async killTree(): Promise<boolean> {
      if (exited) {
        return true
      }
      const treeTerminated = await forceTerminateProcessTree(child)
      if (exited) {
        return true
      }
      if (!treeTerminated) {
        return false
      }
      await sleep(FORCED_EXIT_MS)
      return exited
    }
  }
}

export const NATIVE_LANGUAGE_SERVER_GRACEFUL_EXIT_MS = GRACEFUL_EXIT_MS
