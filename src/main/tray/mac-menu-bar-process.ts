import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { spawnProcess } from '@orca/process-host'

import { killMenuBarChild, spawnMenuBarChild } from './mac-menu-bar-child'
import {
  FRAME_LIMIT,
  MenuBarOutput,
  MenuBarQARequest,
  type MenuBarAction,
  type MenuBarQACommand,
  type MenuBarSnapshot
} from './mac-menu-bar-protocol'
const PROBE_INTERVAL = 5_000
const PROBE_TIMEOUT = 15_000
type Generation = {
  child: ChildProcessWithoutNullStreams
  exited: Promise<void>
  retired: boolean
  ready: boolean
  output: MenuBarOutput
  sentRevision: number
  appliedRevision: number
  sequence: number
  probe: number | null
  deadline: number
  started: number
}

type Options = {
  onAction: (action: MenuBarAction) => void
  onCreated?: () => void
  spawn?: typeof spawnProcess
  qa?: boolean
  executable?: string
}

/** One disposable native owner; no operation waits for its UI thread. */
export class MacMenuBarProcess {
  private current: Generation | null = null
  private desired: MenuBarSnapshot | null = null
  private revision = 0
  private probeId = 0
  private retryDelay = 1_000
  private timer: ReturnType<typeof setTimeout> | null = null
  private suspended = false
  private stopped = false
  private readonly qa = new MenuBarQARequest()

  constructor(private readonly options: Options) {}

  update(snapshot: MenuBarSnapshot): void {
    if (this.stopped) {
      return
    }
    this.desired = snapshot
    this.revision++
    if (!this.current && !this.timer) {
      this.start()
    }
    this.flush()
  }

  suspend(): void {
    this.suspended = true
  }

  resume(): void {
    this.suspended = false
    if (this.current) {
      this.current.deadline = performance.now() + PROBE_TIMEOUT
    }
    this.schedule(PROBE_INTERVAL)
  }

  destroy(): Promise<void> {
    this.stopped = true
    this.desired = null
    this.clearTimer()
    return this.current ? this.retire(this.current) : Promise.resolve()
  }

  inspectForQA(command: MenuBarQACommand): Promise<unknown> {
    const generation = this.current
    if (!this.options.qa || !generation?.ready || generation.retired) {
      return Promise.reject(new Error('Menu bar QA capability unavailable'))
    }
    return this.qa.request(
      () => this.write(generation, { ...command, type: 'qa' }),
      () => {
        void this.retire(generation)
      }
    )
  }

  private start(): void {
    if (this.stopped || this.current || !this.desired) {
      return
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnMenuBarChild(this.options.spawn, this.options.qa, this.options.executable)
    } catch (error) {
      console.warn('[menu-bar] helper could not start', error)
      this.retry()
      return
    }
    let observeExit!: () => void
    const generation: Generation = {
      child,
      exited: new Promise<void>((resolve) => {
        observeExit = resolve
      }),
      retired: false,
      ready: false,
      output: new MenuBarOutput(),
      sentRevision: 0,
      appliedRevision: 0,
      sequence: 0,
      probe: null,
      deadline: performance.now() + PROBE_TIMEOUT,
      started: performance.now()
    }
    this.current = generation
    const force = (): void => killMenuBarChild(generation.child)
    process.on('exit', force)
    let finished = false
    const finish = (): void => {
      if (finished) {
        return
      }
      finished = true
      generation.retired = true
      process.off('exit', force)
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      observeExit()
      if (this.current !== generation) {
        return
      }
      this.current = null
      this.clearTimer()
      this.qa.reject()
      if (!this.stopped) {
        this.retry()
      }
    }
    child.once('exit', finish)
    const fault = (): void => {
      void this.retire(generation)
    }
    child.on('error', () => {
      // Failed spawn has no process and emits no exit; a live child still needs observed exit.
      if (!child.pid) {
        finish()
      } else {
        fault()
      }
    })
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', fault)
    }
    child.stderr.on('data', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.read(generation, chunk))
    child.stdin.on('drain', () => this.flush())
    this.schedule(PROBE_INTERVAL)
  }

  private read(generation: Generation, chunk: string): void {
    if (this.current !== generation || generation.retired) {
      return
    }
    try {
      for (const message of generation.output.read(chunk)) {
        if (this.current !== generation || generation.retired) {
          return
        }
        if (message.type === 'ready' && !generation.ready) {
          generation.ready = true
          generation.deadline = performance.now() + PROBE_TIMEOUT
          this.flush()
        } else if (message.type === 'applied' && message.id === generation.sentRevision) {
          const first = generation.appliedRevision === 0
          generation.appliedRevision = message.id
          if (first) {
            this.options.onCreated?.()
          }
          this.flush()
        } else if (message.type === 'pong' && message.id === generation.probe) {
          generation.probe = null
          generation.deadline = performance.now() + PROBE_TIMEOUT
          if (performance.now() - generation.started > 60_000) {
            this.retryDelay = 1_000
          }
        } else if (
          message.type === 'action' &&
          generation.ready &&
          generation.appliedRevision > 0
        ) {
          if (message.sequence <= generation.sequence) {
            continue
          }
          generation.sequence = message.sequence
          if (
            this.desired?.menu.some((item) => item.id === message.action && item.enabled !== false)
          ) {
            this.options.onAction(message.action)
          }
        } else if (message.type === 'qa' && this.options.qa) {
          this.qa.resolve(message)
        } else {
          throw new Error('Invalid menu bar protocol message')
        }
      }
    } catch {
      void this.retire(generation)
    }
  }

  private flush(): void {
    const generation = this.current
    if (
      !generation?.ready ||
      generation.retired ||
      !this.desired ||
      generation.child.stdin.writableNeedDrain ||
      generation.sentRevision !== generation.appliedRevision ||
      generation.sentRevision === this.revision
    ) {
      return
    }
    generation.sentRevision = this.revision
    this.write(generation, { type: 'state', id: this.revision, snapshot: this.desired })
  }

  private write(generation: Generation, message: unknown): void {
    if (generation.retired) {
      return
    }
    const frame = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(frame) > FRAME_LIMIT || generation.child.stdin.writableNeedDrain) {
      void this.retire(generation)
      return
    }
    try {
      generation.child.stdin.write(frame, (error) => {
        if (error) {
          void this.retire(generation)
        }
      })
    } catch {
      void this.retire(generation)
    }
  }

  private schedule(delay: number): void {
    this.clearTimer()
    if (this.stopped) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      const generation = this.current
      if (!generation) {
        this.start()
        return
      }
      if (!generation.retired && !this.suspended) {
        if (performance.now() >= generation.deadline) {
          void this.retire(generation)
          return
        }
        if (
          generation.ready &&
          generation.probe === null &&
          !generation.child.stdin.writableNeedDrain
        ) {
          generation.probe = ++this.probeId
          this.write(generation, { type: 'ping', id: generation.probe })
        }
      }
      this.schedule(PROBE_INTERVAL)
    }, delay)
    this.timer.unref()
  }

  private retry(): void {
    this.schedule(this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, 60_000)
  }

  private retire(generation: Generation): Promise<void> {
    if (generation.retired) {
      return generation.exited
    }
    generation.retired = true
    this.qa.reject()
    generation.child.stdin.destroy()
    killMenuBarChild(generation.child)
    return generation.exited
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
  }
}
