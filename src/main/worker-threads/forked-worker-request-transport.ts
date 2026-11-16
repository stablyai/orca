import { EventEmitter } from 'node:events'
import { dirname } from 'node:path'
import { forkProcess } from '@orca/process-host/fork-process'
import type { WorkerRequestTransport } from './worker-thread-transport'
import {
  pickAllowedEnv,
  RUNTIME_ENV_ALLOWLIST
} from '../ai-vault/scan-service/session-scanner-service-env'

/** A separate process keeps blocked filesystem calls out of the parent's libuv pool. */
export function forkWorkerRequestTransport(modulePath: string): WorkerRequestTransport {
  const child = forkProcess({
    modulePath,
    cwd: dirname(modulePath),
    execArgv: [],
    env: {
      ...pickAllowedEnv(RUNTIME_ENV_ALLOWLIST, process.env, process.platform),
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  const events = new EventEmitter()
  let exited = false
  let resolveExit!: (code: number) => void
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve
  })
  const kill = (): void => {
    if (exited) {
      return
    }
    try {
      child.kill('SIGKILL')
    } catch {
      // Keep ownership until exit is observed even if signalling fails.
    }
  }
  const finish = (code: number | null): void => {
    if (exited) {
      return
    }
    exited = true
    process.off('exit', kill)
    resolveExit(code ?? 1)
    events.emit('exit', code ?? 1)
  }
  const fail = (error: Error): void => {
    // Retirement detaches the queue's listeners before a failed send can finish.
    if (events.listenerCount('error') > 0) {
      events.emit('error', error)
    }
  }
  process.once('exit', kill)
  child.on('message', (message) => events.emit('message', message))
  child.on('error', fail)
  child.once('exit', finish)
  child.once('close', finish)
  return Object.assign(events, {
    unref(): void {
      child.unref()
      child.channel?.unref()
    },
    postMessage(message: Parameters<WorkerRequestTransport['postMessage']>[0]): void {
      if (!child.connected) {
        throw new Error('Filesystem probe process disconnected')
      }
      child.send(message, (error) => {
        if (error) {
          fail(error)
        }
      })
    },
    terminate(): Promise<number> {
      kill()
      // A sent signal is not exit proof; a stuck child keeps its physical slot.
      return exit
    }
  })
}
