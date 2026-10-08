import { isAbsolute, resolve } from 'node:path'
import { parse, stringify } from 'devalue'
import type { PoolOptions, PoolWorker, WorkerRequest } from 'vitest/node'
import { spawnProcess, type ChildProcessHandle } from '../../src/shared/child-process/run-process'

class NodeRuntimeWorker implements PoolWorker {
  readonly name = 'node-runtime'
  readonly cacheFs = true
  private child: ChildProcessHandle | undefined

  constructor(private readonly options: PoolOptions) {}

  async start(): Promise<void> {
    if (this.child) {
      return
    }
    const executable =
      this.options.env.ORCA_TEST_NODE_EXECUTABLE ?? this.options.env.npm_node_execpath
    if (!executable || !isAbsolute(executable)) {
      throw new Error('Node runtime contracts require pnpm test or run-vitest.mjs')
    }
    const child = spawnProcess({
      program: executable,
      args: [
        ...this.options.execArgv,
        resolve(this.options.project.config.root, 'config/scripts/vitest-node-runtime-worker.mjs')
      ],
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      serialization: 'json'
    })
    this.child = child
    child.stdout.on('error', (error) => this.options.project.vitest.logger.error(error))
    child.stderr.on('error', (error) => this.options.project.vitest.logger.error(error))
    for (const [source, destination] of [
      [child.stdout, this.options.project.vitest.logger.outputStream],
      [child.stderr, this.options.project.vitest.logger.errorStream]
    ] as const) {
      destination.setMaxListeners(destination.getMaxListeners() + 1)
      source.pipe(destination)
    }
    await new Promise<void>((resolve, reject) => {
      const spawned = (): void => {
        child.off('error', failed)
        resolve()
      }
      const failed = (error: Error): void => {
        child.off('spawn', spawned)
        reject(error)
      }
      child.once('spawn', spawned)
      child.once('error', failed)
    })
  }

  on(event: string, callback: (arg: unknown) => void): void {
    this.worker.on(event, callback)
  }

  off(event: string, callback: (arg: unknown) => void): void {
    this.worker.off(event, callback)
  }

  send(message: WorkerRequest): void {
    this.worker.send(stringify(message))
  }

  deserialize(data: unknown): unknown {
    if (typeof data !== 'string') {
      throw new Error('Invalid Node Vitest worker message')
    }
    return parse(data)
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) {
      return
    }
    try {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            clearTimeout(force)
            clearTimeout(deadline)
            child.off('exit', finished)
          }
          const finished = (): void => {
            cleanup()
            resolve()
          }
          const terminate = (signal: NodeJS.Signals): void => {
            try {
              child.kill(signal)
            } catch (error) {
              cleanup()
              reject(error)
            }
          }
          const force = setTimeout(() => terminate('SIGKILL'), 500)
          const deadline = setTimeout(() => {
            cleanup()
            reject(new Error(`Node Vitest worker ${child.pid} did not exit after SIGKILL`))
          }, 2_000)
          child.once('exit', finished)
          terminate('SIGTERM')
        })
      }
    } finally {
      for (const [source, destination] of [
        [child.stdout, this.options.project.vitest.logger.outputStream],
        [child.stderr, this.options.project.vitest.logger.errorStream]
      ] as const) {
        source?.unpipe(destination)
        destination.setMaxListeners(destination.getMaxListeners() - 1)
      }
      this.child = undefined
    }
  }

  private get worker(): ChildProcessHandle {
    if (!this.child) {
      throw new Error('Node Vitest worker is not running')
    }
    return this.child
  }
}

export const nodeRuntimePool = {
  name: 'node-runtime',
  createPoolWorker: (options: PoolOptions) => new NodeRuntimeWorker(options)
}
