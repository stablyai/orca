import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  createPluginWorkerRuntime,
  type PluginWorkerOrcaApi,
  type PluginWorkerRuntime
} from './plugin-host-runtime'

export class UninstallWorkerPort extends EventEmitter {
  connected = true
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private api: PluginWorkerOrcaApi | null = null
  private readonly runtime: PluginWorkerRuntime

  constructor() {
    super()
    this.runtime = createPluginWorkerRuntime({
      send: (message) => this.emit('message', message),
      importModule: async () => ({
        default: (api: PluginWorkerOrcaApi) => {
          this.api = api
          api.commands.register('run', () => {
            for (let index = 0; index < 205; index += 1) {
              api.log(`log-${index}`)
            }
          })
        },
        deactivate: () => this.api?.log('shutdown-log')
      }),
      exit: (code) => this.exit(code)
    })
  }

  send(message: unknown): boolean {
    queueMicrotask(() => {
      void this.runtime.handleMessage(message)
    })
    return true
  }

  kill(): boolean {
    this.exit(0)
    return true
  }

  private exit(code: number): void {
    queueMicrotask(() => {
      this.connected = false
      this.emit('exit', code)
      this.emit('close', code)
    })
  }

  emitSdkLog(message: string): void {
    if (!this.api) {
      throw new Error('Worker has not initialized')
    }
    this.api.log(message)
  }

  emitLateLog(message: string): void {
    this.emit('message', { type: 'log', level: 'info', message })
  }

  finishStdio(): void {
    this.stdout.end()
    this.stderr.end()
  }
}
