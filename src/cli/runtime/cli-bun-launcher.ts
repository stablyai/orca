import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
import { createServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:os'
import { spawnProcess } from '../../shared/child-process/run-process'
import { CLI_LAUNCHER_CHANNEL_ENV } from './cli-launcher-owner'

export function launchBunCli(runtime: string, entry: string, args: string[]): void {
  const env = { ...process.env }
  if (env.ELECTRON_RUN_AS_NODE === '1' && !env.ORCA_APP_EXECUTABLE) {
    env.ORCA_APP_EXECUTABLE = process.execPath
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.NODE_REPL_EXTERNAL_MODULE
  delete env.BUN_OPTIONS
  delete env.ORCA_CLI_LAUNCHER_PIPE
  delete env[CLI_LAUNCHER_CHANNEL_ENV]
  const ownsProcessGroup = process.platform !== 'win32'
  const hasConsole = process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY
  if (!ownsProcessGroup && !hasConsole) {
    const sockets = new Set<Socket>()
    let pendingSignals = ''
    const owner = createServer((socket) => {
      sockets.add(socket)
      socket.write(pendingSignals)
      pendingSignals = ''
      socket.on('error', () => socket.destroy())
      socket.once('close', () => sockets.delete(socket))
      socket.unref()
    })
    env.ORCA_CLI_LAUNCHER_PIPE = `\\\\.\\pipe\\orca-cli-${randomUUID()}`
    owner.once('error', (error) => {
      console.error(error.message)
      process.exitCode = 78
    })
    owner.listen(env.ORCA_CLI_LAUNCHER_PIPE, () => {
      owner.unref()
      const release = (): void => {
        owner.close()
        for (const socket of sockets) {
          socket.destroy()
        }
      }
      try {
        spawnBunCli(runtime, entry, args, env, release, (signal) => {
          const message = signal === 'SIGINT' ? 'I' : 'T'
          if (sockets.size === 0) {
            pendingSignals = (pendingSignals + message).slice(-16)
          } else {
            for (const socket of sockets) {
              socket.write(message)
            }
          }
        })
      } catch (error) {
        release()
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 78
      }
    })
    return
  }
  if (ownsProcessGroup) {
    env[CLI_LAUNCHER_CHANNEL_ENV] = '1'
  }
  spawnBunCli(runtime, entry, args, env, () => {})
}

function spawnBunCli(
  runtime: string,
  entry: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  releaseOwner: () => void,
  forwardWindowsSignal?: (signal: NodeJS.Signals) => void
): void {
  const ownsProcessGroup = process.platform !== 'win32'
  let child: ReturnType<typeof spawnProcess> | undefined
  const pendingSignals: NodeJS.Signals[] = []
  const forwardedSignals: NodeJS.Signals[] = ownsProcessGroup
    ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTSTP', 'SIGCONT']
    : ['SIGINT', 'SIGTERM']
  const signals = forwardedSignals.map((signal) => {
    const forward = (): void => {
      if (!child) {
        pendingSignals.push(signal)
        return
      }
      if (forwardWindowsSignal) {
        forwardWindowsSignal(signal)
        return
      }
      if (process.platform === 'win32' && signal === 'SIGINT') {
        return
      }
      if (child.pid && (signal === 'SIGTSTP' || signal === 'SIGCONT')) {
        try {
          // The detached session has no controlling terminal to deliver job-control signals.
          process.kill(-child.pid, signal === 'SIGTSTP' ? 'SIGSTOP' : signal)
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
            throw error
          }
        }
      } else {
        child.kill(signal)
      }
      if (signal === 'SIGTSTP') {
        process.kill(process.pid, 'SIGSTOP')
      }
    }
    process.on(signal, forward)
    return { signal, forward }
  })
  const cleanup = (): void => {
    releaseOwner()
    for (const { signal, forward } of signals) {
      process.off(signal, forward)
    }
  }
  // A fast child can report readiness before spawn returns to the launcher.
  try {
    child = spawnProcess({
      program: runtime,
      args: [...bunOwnedRuntimeArgs(), entry, ...args],
      env,
      // Detachment escapes Node's Windows job but cannot inherit console handles.
      detached: ownsProcessGroup || !!forwardWindowsSignal,
      stdio: ownsProcessGroup ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit'
    })
  } catch (error) {
    cleanup()
    throw error
  }
  child.once('error', (error) => {
    cleanup()
    console.error(error.message)
    process.exitCode = 78
  })
  child.once('exit', (code, signal) => {
    cleanup()
    if (signal && process.platform !== 'win32') {
      process.kill(process.pid, signal)
    } else {
      process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1)
    }
  })
  for (const signal of pendingSignals) {
    signals.find((entry) => entry.signal === signal)?.forward()
  }
}
