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
import { MenuBarReplyDeadline } from './mac-menu-bar-reply-deadline'
import { MenuBarRestartPolicy } from './mac-menu-bar-restart-policy'
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
  started: number
}

type Options = {
  onAction: (action: MenuBarAction) => void
  onCreated?: () => void
  /** True once a helper shows the icon, false when that helper exits. */
  onOwnerChange?: (owned: boolean) => void
  /** 'fallback': the helper can't start, use the in-process icon; 'off': started helpers keep failing. */
  onUnavailable?: (reason: 'fallback' | 'off') => void
  spawn?: typeof spawnProcess
  qa?: boolean
  executable?: string
}

/** One disposable native owner; no operation waits for its UI thread. */
export class MacMenuBarProcess {
  private current: Generation | null = null
  private desired: MenuBarSnapshot | null = null
  private revision = 0
  private created = false
  private probeId = 0
  private readonly restarts = new MenuBarRestartPolicy()
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Paused across system sleep (the tray wires powerMonitor) so a sleeping helper isn't killed. */
  readonly deadline = new MenuBarReplyDeadline()
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

  /** Called on user-visible events (window focus, app activation) to replace a hung helper without polling. */
  probe(): void {
    const generation = this.current
    if (!generation?.ready || generation.retired || this.deadline.armed || this.deadline.paused) {
      return
    }
    generation.probe = ++this.probeId
    this.write(generation, { type: 'ping', id: generation.probe })
    this.arm(generation)
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
      this.afterFailedGeneration(false, 0)
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
      if (generation.appliedRevision > 0) {
        this.options.onOwnerChange?.(false)
      }
      if (this.current !== generation) {
        return
      }
      this.current = null
      this.clearTimer()
      this.qa.reject()
      if (this.stopped) {
        return
      }
      this.afterFailedGeneration(generation.ready, performance.now() - generation.started)
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
    this.arm(generation)
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
          this.deadline.disarm()
          this.flush()
        } else if (message.type === 'pong' && message.id === generation.probe) {
          generation.probe = null
          if (generation.sentRevision === generation.appliedRevision) {
            this.deadline.disarm()
          }
        } else if (message.type === 'deferred' && message.id === generation.sentRevision) {
          // The menu is open and its UI thread answered; the helper applies on close.
          if (generation.probe === null) {
            this.deadline.disarm()
          }
        } else if (message.type === 'applied' && message.id === generation.sentRevision) {
          const first = generation.appliedRevision === 0
          generation.appliedRevision = message.id
          if (generation.probe === null) {
            this.deadline.disarm()
          }
          if (first) {
            this.options.onOwnerChange?.(true)
            if (!this.created) {
              this.created = true
              this.options.onCreated?.()
            }
          }
          this.flush()
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
    this.arm(generation)
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

  // retire() ignores a generation that already ended.
  private arm(generation: Generation): void {
    this.deadline.arm(() => void this.retire(generation))
  }

  private schedule(delay: number): void {
    this.clearTimer()
    if (this.stopped) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.current) {
        this.start()
      }
    }, delay)
    this.timer.unref()
  }

  private afterFailedGeneration(reachedReady: boolean, livedMs: number): void {
    const next = this.restarts.next(reachedReady, livedMs)
    if (typeof next === 'number') {
      this.schedule(next)
      return
    }
    console.warn(`[menu-bar] helper keeps failing (${next})`)
    this.stopped = true
    this.options.onUnavailable?.(next)
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

  // Restart timer and any reply deadline; called when the generation ends or the owner stops.
  private clearTimer(): void {
    clearTimeout(this.timer ?? undefined)
    this.timer = null
    this.deadline.disarm()
  }
}
