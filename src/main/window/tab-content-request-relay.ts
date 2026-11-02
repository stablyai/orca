import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  WindowTabContentOutcome,
  WindowTabContentReply,
  WindowTabContentRequest
} from '../../shared/window-tab-content'
import {
  TerminalNotPlacedError,
  TerminalRevealUnconfirmedError
} from '../runtime/session-tabs/terminal-not-placed-error'
import { addFanoutListener, addFanoutListeners } from '../event-listener-fanout'

const TAB_CONTENT_REPLY_MS = 10_000

/** A switch whose answer is still missing, per workspace: a newer one there retires it. */
const pendingByWorkspace = new Map<string, () => void>()

/**
 * Asks the window that owns the layout to change what one tab holds (or which tab it would), and
 * waits a bounded time for its answer. A switch's change (`operation`) has no deadline of its own:
 * the window applies it at most once whenever it arrives, while its grant holds. A missing answer
 * is asked again read-only (`status`), and one still missing is unknown, never a refusal. The
 * page's end (closed, crashed, navigated) is unknown too. `late` hears an answer that arrives
 * after that, until the page ends or a newer switch in the workspace asks.
 */
export function requestTabContentFromRenderer(
  mainWindow: BrowserWindow,
  request: Omit<WindowTabContentRequest, 'requestId'>,
  late?: (outcome: WindowTabContentOutcome) => void
): Promise<WindowTabContentOutcome> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.reject(new TerminalNotPlacedError('renderer_unavailable'))
  }
  const webContents = mainWindow.webContents
  const change = request.operation !== undefined && !request.decide && !request.status
  if (change) {
    pendingByWorkspace.get(request.worktreeId)?.()
  }
  const requestIds = new Set<string>()
  const releaseListeners: (() => void)[] = []
  let observe: ((outcome: WindowTabContentOutcome | Error) => void) | null = null
  const release = (): void => {
    if (pendingByWorkspace.get(request.worktreeId) === release) {
      pendingByWorkspace.delete(request.worktreeId)
    }
    for (const stop of releaseListeners.splice(0)) {
      stop()
    }
  }
  const settle = (outcome: WindowTabContentOutcome | Error): void => {
    if (observe) {
      observe(outcome)
    } else {
      release()
      if (!(outcome instanceof Error)) {
        late?.(outcome)
      }
    }
  }
  const onReply = (event: Electron.IpcMainEvent, reply: WindowTabContentReply): void => {
    // Renderer-supplied request ids confer no authority; only this window answers.
    if (event.sender !== webContents || !requestIds.has(reply.requestId)) {
      return
    }
    const { requestId: _id, error, ...outcome } = reply
    settle(error ? new TerminalRevealUnconfirmedError(error) : outcome)
  }
  /** The page this request went to has ended: nothing it sent counts any more. */
  let ended = false
  const onGone = (): void => {
    ended = true
    settle(new TerminalRevealUnconfirmedError('renderer_unavailable'))
  }
  releaseListeners.push(
    addFanoutListener(ipcMain, 'ui:tabContentReply', onReply),
    addFanoutListener(mainWindow, 'closed', onGone),
    addFanoutListeners(webContents, ['destroyed', 'render-process-gone'], onGone),
    addFanoutListener(
      webContents,
      'did-start-navigation',
      (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !isInPlace) {
          onGone()
        }
      }
    )
  )
  const ask = (asked: Omit<WindowTabContentRequest, 'requestId'>) =>
    new Promise<WindowTabContentOutcome>((resolve, reject) => {
      const requestId = randomUUID()
      requestIds.add(requestId)
      const timeout = setTimeout(
        () => observe?.(new TerminalRevealUnconfirmedError('Tab content change unanswered')),
        TAB_CONTENT_REPLY_MS
      )
      observe = (outcome) => {
        clearTimeout(timeout)
        observe = null
        if (outcome instanceof Error) {
          reject(outcome)
        } else {
          resolve(outcome)
        }
      }
      try {
        webContents.send('ui:setTabContent', { ...asked, requestId })
      } catch {
        // Never sent: nothing changed.
        observe(new TerminalNotPlacedError('renderer_unavailable'))
      }
    })
  const answered = async (): Promise<WindowTabContentOutcome> => {
    try {
      return await ask(request)
    } catch (error) {
      if (!change || !(error instanceof TerminalRevealUnconfirmedError) || ended) {
        throw error
      }
    }
    // The change's answer went missing: ask what it did, changing nothing.
    return ask({ ...request, status: true })
  }
  return answered().then(
    (outcome) => {
      release()
      return outcome
    },
    (error: unknown) => {
      if (change && late && error instanceof TerminalRevealUnconfirmedError && !ended) {
        pendingByWorkspace.set(request.worktreeId, release)
      } else {
        release()
      }
      throw error
    }
  )
}
