import { ipcMain } from 'electron'
import {
  closeDetachedTerminalWindow,
  createOrFocusDetachedTerminalWindow,
  getDetachedTerminalInput,
  isDetachedTerminalRendererForTab,
  updateDetachedTerminalInput,
  type DetachedTerminalWindowArgs
} from '../window/detached-terminal-window'
import {
  MAX_DETACHED_TERMINAL_ID_LENGTH,
  MAX_DETACHED_TERMINAL_TITLE_LENGTH
} from '../../shared/detached-terminal-limits'
import type { DashboardCardTerminalInput } from '../../shared/dashboard-snapshot'
import { isDashboardTerminalInput } from './dashboard-payload-validation'
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

// Why: the input facts pick the bytes the companion sends, so a malformed set is refused, not coerced.
function admitTerminalInput(value: unknown): DashboardCardTerminalInput | null | undefined {
  const terminalInput =
    value && typeof value === 'object' && 'terminalInput' in value ? value.terminalInput : null
  if (terminalInput === null || terminalInput === undefined) {
    return null
  }
  return isDashboardTerminalInput(terminalInput)
    ? (terminalInput as DashboardCardTerminalInput)
    : undefined
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
  ipcMain.handle('detachedTerminal:setTerminalInput', (event, value: unknown): void => {
    const tabId = admitTabId(value)
    const terminalInput = admitTerminalInput(value)
    if (tabId && terminalInput !== undefined && isTrustedUIRenderer(event.sender)) {
      updateDetachedTerminalInput(tabId, terminalInput)
    }
  })
  ipcMain.handle(
    'detachedTerminal:getTerminalInput',
    (event, value: unknown): DashboardCardTerminalInput | null | undefined => {
      const tabId = admitTabId(value)
      return tabId && isDetachedTerminalRendererForTab(event.sender, tabId)
        ? getDetachedTerminalInput(tabId)
        : undefined
    }
  )
}
