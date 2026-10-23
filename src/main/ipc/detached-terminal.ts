import { ipcMain } from 'electron'
import {
  closeDetachedTerminalWindow,
  createOrFocusDetachedTerminalWindow,
  isDetachedTerminalRendererForTab,
  type DetachedTerminalWindowArgs
} from '../window/detached-terminal-window'
import {
  MAX_DETACHED_TERMINAL_ID_LENGTH,
  MAX_DETACHED_TERMINAL_TITLE_LENGTH
} from '../../shared/detached-terminal-limits'
import { isTrustedUIRenderer } from './ui'

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function admitOpenArgs(value: unknown): DetachedTerminalWindowArgs | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const tabId = 'tabId' in value ? value.tabId : null
  const ptyId = 'ptyId' in value ? value.ptyId : null
  const title = 'title' in value ? value.title : null
  if (
    !isNonEmptyString(tabId, MAX_DETACHED_TERMINAL_ID_LENGTH) ||
    !isNonEmptyString(ptyId, MAX_DETACHED_TERMINAL_ID_LENGTH) ||
    !isNonEmptyString(title, MAX_DETACHED_TERMINAL_TITLE_LENGTH)
  ) {
    return null
  }
  return { tabId, ptyId, title }
}

function admitTabId(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const tabId = 'tabId' in value ? value.tabId : null
  return isNonEmptyString(tabId, MAX_DETACHED_TERMINAL_ID_LENGTH) ? tabId : null
}

export function registerDetachedTerminalHandlers(): void {
  ipcMain.handle('detachedTerminal:open', (event, value: unknown): boolean => {
    const args = admitOpenArgs(value)
    if (args && isTrustedUIRenderer(event.sender)) {
      createOrFocusDetachedTerminalWindow(args)
      return true
    }
    return false
  })
  ipcMain.handle('detachedTerminal:close', (event, value: unknown): void => {
    const tabId = admitTabId(value)
    if (tabId && isTrustedUIRenderer(event.sender)) {
      closeDetachedTerminalWindow(tabId)
    }
  })
  ipcMain.handle('detachedTerminal:returnToMain', (event, value: unknown): void => {
    const tabId = admitTabId(value)
    if (tabId && isDetachedTerminalRendererForTab(event.sender, tabId)) {
      closeDetachedTerminalWindow(tabId)
    }
  })
}
