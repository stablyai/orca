import { BrowserWindow, ipcMain } from 'electron'
import { parseTerminalIndex, type A2ALinkEvent } from '../../shared/terminal-a2a-link'

export const TERMINAL_A2A_LINK_CHANNEL = 'terminal:a2a-link'

export function broadcastA2ALink(
  event: A2ALinkEvent,
  options?: { getWindows?: () => BrowserWindow[] }
): void {
  const windows = options?.getWindows ? options.getWindows() : BrowserWindow.getAllWindows()
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send(TERMINAL_A2A_LINK_CHANNEL, event)
    }
  }
}

type TerminalDescriptorLike = {
  handle: string
  index?: number | null
  title?: string | null
  preview?: string | null
  branch?: string | null
}

type RuntimeTerminalBridgeLike = {
  listTerminals: () => Promise<{ terminals?: TerminalDescriptorLike[] } | undefined>
  sendTerminal: (
    handle: string,
    payload: { text: string; enter?: boolean; interrupt?: boolean }
  ) => Promise<{ accepted?: boolean; bytesWritten?: number } | undefined>
}

export function registerTerminalA2AHandlers(options?: {
  ipc?: typeof ipcMain
  getWindows?: () => BrowserWindow[]
  getRuntime?: () => RuntimeTerminalBridgeLike | null | undefined
}): void {
  const ipc = options?.ipc ?? (ipcMain && typeof ipcMain.handle === 'function' ? ipcMain : null)
  if (!ipc) {
    return
  }
  try {
    if (typeof ipc.removeHandler === 'function') {
      ipc.removeHandler(TERMINAL_A2A_LINK_CHANNEL)
    }
  } catch {
    // Ignore when handler was not registered
  }
  ipc.handle(TERMINAL_A2A_LINK_CHANNEL, async (_event, event: A2ALinkEvent) => {
    let delivered = event.delivered ?? false
    let targetHandle = event.targetHandle
    let bytesWritten = event.bytesWritten ?? 0
    let executionState = event.executionState ?? 'simulated'
    let errorMessage = event.error

    const runtime = options?.getRuntime?.()
    if (event.text && runtime) {
      try {
        const listRes = await runtime.listTerminals()
        const terminals = listRes?.terminals ?? []

        const targetIndex = event.toIndex ?? parseTerminalIndex(event.to)
        let match = terminals.find((t: TerminalDescriptorLike) => t.handle === event.to)
        if (!match && targetIndex !== undefined) {
          match = terminals.find(
            (t: TerminalDescriptorLike, idx: number) =>
              t.index === targetIndex || (!t.index && idx + 1 === targetIndex)
          )
        }
        if (!match && event.to.startsWith('@')) {
          const label = event.to.slice(1).toLowerCase()
          match = terminals.find(
            (t: TerminalDescriptorLike) =>
              t.title?.toLowerCase() === label ||
              t.preview?.toLowerCase().includes(label) ||
              t.branch?.toLowerCase() === label
          )
        }

        if (match) {
          targetHandle = match.handle
          let messageToSend = event.text
          if (event.type === 'message') {
            const header = `[orca-bridge from:${event.from} to:${event.to}]`
            messageToSend = `${header} ${event.text}`
          }

          const sendRes = await runtime.sendTerminal(targetHandle, {
            text: messageToSend,
            enter: event.type !== 'type'
          })

          delivered = sendRes?.accepted ?? true
          bytesWritten = sendRes?.bytesWritten ?? messageToSend.length
          executionState = delivered ? 'delivered' : 'failed'
        } else {
          errorMessage = `No active terminal found for target "${event.to}"`
          executionState = 'failed'
        }
      } catch (err: unknown) {
        errorMessage = err instanceof Error ? err.message : String(err)
        executionState = 'failed'
      }
    }

    const enrichedEvent: A2ALinkEvent = {
      ...event,
      delivered,
      targetHandle,
      bytesWritten,
      executionState,
      error: errorMessage
    }

    broadcastA2ALink(enrichedEvent, options)
    return {
      ok: true,
      delivered,
      targetHandle,
      bytesWritten,
      executionState,
      error: errorMessage
    }
  })
}
