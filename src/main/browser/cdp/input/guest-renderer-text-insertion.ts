import type { WebContents } from 'electron'
import { BrowserError } from '../../browser-error'
import {
  readRecord,
  readString,
  settleWithin,
  type GuestSessionCdpSender
} from './guest-frame-input-sessions'

const INSERT_TIMEOUT_MS = 10_000
const INSERT_WORLD_NAME = 'orca-guest-text-insertion'

const insertionScript = (text: string, expiresAt: number): string => `(() => {
  const expiresAt = ${expiresAt}
  const text = ${JSON.stringify(text)}
  const focusedField = () => {
    let doc = document
    for (let depth = 0; depth < 64; depth++) {
      let field = doc.activeElement
      while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement
      if (!field) return null
      if (field.tagName === 'IFRAME' || field.tagName === 'FRAME') {
        doc = field.contentDocument
        if (!doc) return null
        continue
      }
      if (field.disabled || field.readOnly) return null
      const editable = field.isContentEditable || field.tagName === 'TEXTAREA' ||
        (field.tagName === 'INPUT' && ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(field.type))
      return editable ? { doc, field } : null
    }
    return null
  }
  if (Date.now() >= expiresAt) return 'expired'
  const target = focusedField()
  if (!target) return 'unavailable'
  const event = new InputEvent('beforeinput', {
    bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: text
  })
  if (!target.field.dispatchEvent(event)) return 'cancelled'
  // Page handlers can move focus, navigate, or block beyond the deadline.
  const current = focusedField()
  if (!current || current.field !== target.field || current.doc !== target.doc) return 'unavailable'
  if (Date.now() >= expiresAt) return 'expired'
  return Document.prototype.execCommand.call(target.doc, 'insertText', false, text) ? 'inserted' : 'unavailable'
})()`

/** Bind edits to this document's isolated world, so navigation invalidates queued work. */
export async function prepareGuestTextInsertion(
  send: GuestSessionCdpSender
): Promise<(webContents: WebContents, text: string) => Promise<void>> {
  const tree = await settleWithin(send('Page.getFrameTree', {}), null)
  const frameId = readString(readRecord(readRecord(tree, 'frameTree'), 'frame'), 'id')
  const world = frameId
    ? await settleWithin(
        send('Page.createIsolatedWorld', { frameId, worldName: INSERT_WORLD_NAME }),
        null
      )
    : null
  const contextId =
    world && typeof world === 'object' && 'executionContextId' in world
      ? world.executionContextId
      : null
  if (typeof contextId !== 'number') {
    throw unavailableError()
  }
  return (webContents, text) => insertGuestText(webContents, send, contextId, text)
}

function unavailableError(): BrowserError {
  return new BrowserError(
    'browser_input_target_unavailable',
    'The browser page has no focused editable element to receive text, so it was not sent. Focus a field first.'
  )
}

function timeoutError(): BrowserError {
  return new BrowserError('browser_timeout', 'The browser page did not confirm the text in time.')
}

async function insertGuestText(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  contextId: number,
  text: string
): Promise<void> {
  const expiresAt = Date.now() + INSERT_TIMEOUT_MS
  let stop = (): void => {}
  const abandoned = new Promise<never>((_resolve, reject) => {
    const fail = (): void =>
      reject(
        new BrowserError(
          'browser_error',
          'The browser page crashed or closed before it confirmed the text.'
        )
      )
    const timer = setTimeout(() => reject(timeoutError()), INSERT_TIMEOUT_MS)
    webContents.once('render-process-gone', fail)
    webContents.once('destroyed', fail)
    stop = () => {
      clearTimeout(timer)
      webContents.removeListener('render-process-gone', fail)
      webContents.removeListener('destroyed', fail)
    }
  })
  try {
    const response = await Promise.race([
      send('Runtime.evaluate', {
        expression: insertionScript(text, expiresAt),
        contextId,
        returnByValue: true
      }).catch(() => {
        throw unavailableError()
      }),
      abandoned
    ])
    const outcome = readRecord(response, 'result')?.value
    if (outcome === 'expired') {
      throw timeoutError()
    }
    if (outcome !== 'inserted' && outcome !== 'cancelled') {
      throw unavailableError()
    }
  } finally {
    stop()
  }
}
