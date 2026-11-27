import { sendPrivate, retireGrabOverlay, type GrabDocumentScope } from './grab-document-scope'
import { freshGrabDocumentScope, settleGrabOverlayArm } from './grab-overlay-arm'
export { retireGrabOverlay, restoreGrabCapture } from './grab-document-scope'
export type { GrabDocumentScope } from './grab-document-scope'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import {
  GRAB_EXECUTION_REQUEST,
  GRAB_EXECUTION_REPORT,
  type GrabExecutionResult
} from '../../../shared/browser/element-grab/grab-execution-protocol'
import type {
  GrabExecutionOptions as Options,
  GrabExecutionTask as Task
} from './grab-guest-execution-types'

const sessions = new WeakMap<WebContents, GrabGuestExecution>()

/** At most one active and one waiting request per lane; background checks never queue. */
class GrabGuestExecution {
  scope: GrabDocumentScope = freshGrabDocumentScope()
  private script: Task | null = null
  private selection: Task | null = null
  private waiting: Task | null = null
  private waitingSelection: Task | null = null
  private readonly scriptIdle = new Set<() => void>()

  constructor(private readonly guest: WebContents) {
    guest.on('ipc-message', this.onReport)
    guest.on('did-start-navigation', this.onNavigation)
    guest.on('render-process-gone', this.retire)
    guest.once('destroyed', this.destroy)
  }

  /** Resolves once the script lane has no active or waiting request, or the document retires. */
  whenScriptLaneIdle(): Promise<void> {
    if (!this.script && !this.waiting) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.scriptIdle.add(resolve))
  }

  private notifyScriptIdle(): void {
    if (this.script || this.waiting) {
      return
    }
    const waiters = [...this.scriptIdle]
    this.scriptIdle.clear()
    for (const resolve of waiters) {
      resolve()
    }
  }

  run(code: string, options: Options): Promise<GrabExecutionResult> {
    const scope = options.scope ?? this.scope
    options = { ...options, scope }
    if (
      this.guest.isDestroyed() ||
      options.signal?.aborted ||
      scope !== this.scope ||
      !scope.current
    ) {
      return Promise.resolve({ ok: false })
    }
    if (
      (options.background || options.loadedOnly) &&
      (this.guest.isLoadingMainFrame() || !this.guest.getURL())
    ) {
      return Promise.resolve({ ok: false })
    }
    const occupied = options.selection ? this.selection : this.script
    const waiting = options.selection ? this.waitingSelection : this.waiting
    if (occupied && (options.background || waiting || (options.selection && occupied.live))) {
      return Promise.resolve({ ok: false })
    }
    return new Promise((resolve) => {
      const task: Task = {
        id: randomUUID(),
        code,
        options,
        frame: null,
        documentId: null,
        started: false,
        live: true,
        resolve,
        stopWaiting: () => {}
      }
      const abort = (): void => {
        if (task.started && task.options.overlayControl && task.documentId) {
          sendPrivate(task.frame, {
            kind: 'retire',
            documentId: task.documentId,
            overlayId: task.id
          })
        }
        this.finish(task, { ok: false }, !task.started)
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      task.stopWaiting = () => options.signal?.removeEventListener('abort', abort)
      if (occupied) {
        if (options.selection) {
          this.waitingSelection = task
        } else {
          this.waiting = task
        }
        const ready = (): void => {
          if (!this.guest.isLoadingMainFrame() && this.guest.getURL() && task.live) {
            this.guest.off('did-stop-loading', ready)
            task.timer = setTimeout(abort, 2_000)
          }
        }
        const stop = task.stopWaiting
        task.stopWaiting = () => {
          stop()
          this.guest.off('did-stop-loading', ready)
        }
        this.guest.on('did-stop-loading', ready)
        ready()
      } else {
        this.begin(task)
      }
    })
  }

  private begin(task: Task): void {
    if (task.options.selection) {
      this.selection = task
    } else {
      this.script = task
    }
    const loaded = (): void => {
      this.guest.off('did-stop-loading', loaded)
      if (!task.live || this.guest.isDestroyed() || task.options.scope !== this.scope) {
        return
      }
      try {
        task.frame = this.guest.mainFrame
        task.timer = setTimeout(() => this.finish(task, { ok: false }, !task.started), 2_000)
        task.frame.send(GRAB_EXECUTION_REQUEST, { kind: 'hello', id: task.id })
      } catch {
        this.finish(task, { ok: false }, true)
      }
    }
    if (this.guest.isLoadingMainFrame() || !this.guest.getURL()) {
      const stop = task.stopWaiting
      task.stopWaiting = () => {
        stop()
        this.guest.off('did-stop-loading', loaded)
      }
      this.guest.on('did-stop-loading', loaded)
    } else {
      loaded()
    }
  }

  private finish(task: Task, result: GrabExecutionResult, release: boolean): void {
    if (task.live) {
      task.live = false
      clearTimeout(task.timer)
      task.stopWaiting()
      task.code = ''
      task.resolve(result)
      task.resolve = () => {}
    }
    if (!release) {
      return
    }
    if (this.selection === task) {
      this.selection = null
    }
    if (this.script === task) {
      this.script = null
    }
    if (this.waiting === task) {
      this.waiting = null
    }
    if (this.waitingSelection === task) {
      this.waitingSelection = null
    }
    if (!this.script && this.waiting) {
      const next = this.waiting
      this.waiting = null
      clearTimeout(next.timer)
      this.begin(next)
    }
    if (!this.selection && this.waitingSelection) {
      const next = this.waitingSelection
      this.waitingSelection = null
      clearTimeout(next.timer)
      this.begin(next)
    }
    this.notifyScriptIdle()
  }

  private readonly onReport = (
    event: Electron.IpcMainEvent,
    channel: string,
    payload: { id?: string; documentId?: string; ready?: boolean; result?: GrabExecutionResult }
  ): void => {
    if (channel !== GRAB_EXECUTION_REPORT || !payload || typeof payload.documentId !== 'string') {
      return
    }
    const task = [this.script, this.selection].find((candidate) => candidate?.id === payload.id)
    if (!task || event.senderFrame !== task.frame || this.guest.mainFrame !== task.frame) {
      return
    }
    if (payload.ready && task.live && !task.started) {
      task.documentId = payload.documentId
      this.scope.documentId = payload.documentId
      this.scope.frame = task.frame
      if (task.options.overlayControl) {
        // The page keeps its current picker until this arm succeeds; cancel retires both meanwhile.
        this.scope.pendingOverlayId = task.id
      }
      task.started = true
      clearTimeout(task.timer)
      task.timer = setTimeout(
        () => {
          // Its caller is told it failed, so a timed-out arm must not go live later.
          settleGrabOverlayArm(this.scope, task.id, null)
          this.finish(task, { ok: false }, false)
          // Recover an already-completed private result if only its reply was lost.
          sendPrivate(task.frame, { kind: 'hello', id: task.id })
        },
        task.options.selection ? 120_000 : 2_000
      )
      try {
        task.frame?.send(GRAB_EXECUTION_REQUEST, {
          kind: 'execute',
          id: task.id,
          documentId: task.documentId,
          code: task.code,
          worldId: task.options.worldId ?? 0,
          lane: task.options.selection ? 'selection' : 'script',
          expiresAt: Date.now() + 2_000,
          clean: task.options.clean,
          overlayControl: task.options.overlayControl,
          capturePick: task.options.capturePick,
          pick: task.options.pick,
          overlayAction: task.options.overlayAction
        })
      } catch {
        settleGrabOverlayArm(this.scope, task.id, null)
        this.finish(task, { ok: false }, true)
      }
      task.code = ''
    } else if (payload.documentId === task.documentId && payload.result) {
      settleGrabOverlayArm(this.scope, task.id, payload.result)
      this.finish(task, payload.result, true)
    }
  }

  private readonly onNavigation = (
    _event: unknown,
    _url: unknown,
    inPlace: boolean,
    main: boolean
  ): void => {
    if (main && !inPlace) {
      this.retire()
    }
  }

  private readonly retire = (): void => {
    retireGrabOverlay(this.scope)
    this.scope.current = false
    this.scope = freshGrabDocumentScope()
    const tasks = [this.script, this.selection, this.waiting, this.waitingSelection]
    this.script = this.selection = this.waiting = this.waitingSelection = null
    for (const task of tasks) {
      if (task) {
        this.finish(task, { ok: false }, true)
      }
    }
    this.notifyScriptIdle()
  }

  private readonly destroy = (): void => {
    this.retire()
    this.guest.off('ipc-message', this.onReport)
    this.guest.off('did-start-navigation', this.onNavigation)
    this.guest.off('render-process-gone', this.retire)
    sessions.delete(this.guest)
  }
}

export function requestGrabExecution(
  guest: WebContents,
  code: string,
  options: Options = {}
): Promise<GrabExecutionResult> {
  if (guest.isDestroyed()) {
    return Promise.resolve({ ok: false })
  }
  return getSession(guest).run(code, options)
}

export async function executeGrabScript(
  guest: WebContents,
  code: string,
  options: Options = {}
): Promise<boolean | null> {
  const result = await requestGrabExecution(guest, code, options)
  return result.ok && typeof result.value === 'boolean' ? result.value : null
}

function getSession(guest: WebContents): GrabGuestExecution {
  let session = sessions.get(guest)
  if (!session) {
    session = new GrabGuestExecution(guest)
    sessions.set(guest, session)
  }
  return session
}

export function whenGrabScriptLaneIdle(guest: WebContents): Promise<void> {
  return guest.isDestroyed() ? Promise.resolve() : getSession(guest).whenScriptLaneIdle()
}

export function grabDocumentScope(guest: WebContents): GrabDocumentScope {
  return getSession(guest).scope
}
