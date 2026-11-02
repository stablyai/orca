import type {
  BrowserJavaScriptDialog,
  BrowserJavaScriptDialogAnswer
} from '../../shared/browser-javascript-dialog'
import {
  browserPagePromptOrigin,
  closeBrowserPagePrompts,
  openBrowserPagePrompt,
  type BrowserPagePromptTarget
} from './browser-page-prompts'

type RunDialogInfo = {
  frame?: { origin?: string } | null
  dialogType: string
  messageText: string
  defaultPromptText: string
}
type RunDialogCallback = (success: boolean, userInput: string) => void
type RunDialogListener = (info: RunDialogInfo, callback: RunDialogCallback) => void

type OpenDialog = {
  guest: Electron.WebContents
  dialog: BrowserJavaScriptDialog
  callback: RunDialogCallback
}

const openDialogs = new Map<number, OpenDialog>()
const openedListeners = new Map<number, Set<(dialog: BrowserJavaScriptDialog) => void>>()

export function getBrowserJavaScriptDialog(guestId: number): BrowserJavaScriptDialog | null {
  return openDialogs.get(guestId)?.dialog ?? null
}

/** False when the page has no dialog open. */
export function answerBrowserJavaScriptDialog(
  guestId: number,
  answer: BrowserJavaScriptDialogAnswer
): boolean {
  const open = openDialogs.get(guestId)
  if (!open) {
    return false
  }
  openDialogs.delete(guestId)
  closeBrowserPagePrompts(open.guest, 'javascript-dialog')
  open.callback(answer.accept, answer.accept ? answer.promptText : '')
  return true
}

export function onBrowserJavaScriptDialogOpened(
  guestId: number,
  listener: (dialog: BrowserJavaScriptDialog) => void
): () => void {
  let listeners = openedListeners.get(guestId)
  if (!listeners) {
    listeners = new Set()
    openedListeners.set(guestId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && openedListeners.get(guestId) === listeners) {
      openedListeners.delete(guestId)
    }
  }
}

function parseAnswer(value: unknown): BrowserJavaScriptDialogAnswer | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'accept' in value &&
    typeof value.accept === 'boolean' &&
    'promptText' in value &&
    typeof value.promptText === 'string'
  ) {
    return { accept: value.accept, promptText: value.promptText }
  }
  return undefined
}

/**
 * Electron's own `-run-dialog` listener shows a sheet over the whole Orca window and refuses
 * prompts; agents answered the same dialog over CDP, which left that sheet stuck. Orca owns it
 * instead, and every answer goes through it: a CDP close event can't say which dialog closed.
 */
export function installBrowserJavaScriptDialogs(
  guest: Electron.WebContents,
  resolveTarget: () => BrowserPagePromptTarget | null
): void {
  const guestId = guest.id
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WebContents is an EventEmitter; its types list only public events, not Electron's private dialog events.
  const events = guest as unknown as NodeJS.EventEmitter
  events.removeAllListeners('-run-dialog')

  const forget = (): void => {
    if (openDialogs.delete(guestId)) {
      closeBrowserPagePrompts(guest, 'javascript-dialog')
    }
  }

  const onRunDialog: RunDialogListener = (info, callback) => {
    // One dialog per page: a second frame's dialog while one is showing is dismissed.
    if (openDialogs.has(guestId)) {
      callback(false, '')
      return
    }
    const dialog: BrowserJavaScriptDialog = {
      type:
        info.dialogType === 'confirm' || info.dialogType === 'prompt' ? info.dialogType : 'alert',
      message: info.messageText,
      defaultPromptText: info.dialogType === 'prompt' ? info.defaultPromptText : ''
    }
    // Name the frame that asked, as Chrome does, so an embedded page can't speak as the site.
    const details = {
      ...dialog,
      origin: browserPagePromptOrigin(info.frame?.origin ?? guest.getURL())
    }
    const open: OpenDialog = { guest, dialog, callback }
    openDialogs.set(guestId, open)
    // With no window to ask in, the dialog waits for an agent or a phone to answer it.
    openBrowserPagePrompt({
      kind: 'javascript-dialog',
      requester: guest,
      target: resolveTarget(),
      details: () => details,
      waitsForAnswer: true,
      parseAnswer,
      settle: (answer) => {
        if (openDialogs.get(guestId) === open) {
          answerBrowserJavaScriptDialog(guestId, answer ?? { accept: false, promptText: '' })
        }
      }
    })
    for (const listener of openedListeners.get(guestId) ?? []) {
      listener(dialog)
    }
  }

  events.on('-run-dialog', onRunDialog)
  events.on('-cancel-dialogs', forget)
  guest.once('destroyed', forget)
}
