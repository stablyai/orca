import { beforeEach, expect, it, vi } from 'vitest'
import * as terminalTabCloseTiming from '../../shared/terminal-tab-close'

const ACK_MARGIN_MS =
  terminalTabCloseTiming.TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS -
  terminalTabCloseTiming.TERMINAL_TAB_CLOSE_RESPONSE_TIMEOUT_MS

const { ipcListeners, ipcMainMock } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    ipcListeners: listeners,
    ipcMainMock: {
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        const channelListeners = listeners.get(channel) ?? new Set()
        channelListeners.add(listener)
        listeners.set(channel, channelListeners)
      }),
      removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        listeners.get(channel)?.delete(listener)
      })
    }
  }
})

vi.mock('electron', () => ({ ipcMain: ipcMainMock }))

import { requestTerminalTabCloseFromRenderer } from './terminal-tab-close-request-relay'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(0))
  ipcListeners.clear()
})

function emitIpc(channel: string, ...args: unknown[]): void {
  for (const listener of ipcListeners.get(channel) ?? []) {
    listener(...args)
  }
}

it('bounds a nested paired close inside the real renderer acknowledgement wall', async () => {
  const webContents = {
    isDestroyed: () => false,
    send: vi.fn((_channel: string, request: { requestId: string; deadlineMs?: number }): void => {
      const timeoutMs =
        request.deadlineMs === undefined ||
        terminalTabCloseTiming.resolveNestedTerminalTabCloseTimeoutMs === undefined
          ? terminalTabCloseTiming.TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS
          : terminalTabCloseTiming.resolveNestedTerminalTabCloseTimeoutMs(request.deadlineMs)
      setTimeout(() => {
        emitIpc(
          'ui:terminalTabCloseResponse',
          { sender: webContents },
          { requestId: request.requestId, error: 'terminal_tab_close_failed' }
        )
      }, timeoutMs)
    })
  }
  let outcome = 'pending'
  const settled = requestTerminalTabCloseFromRenderer(
    { isDestroyed: () => false, webContents } as never,
    'tab-paired'
  ).then(
    () => {
      outcome = 'resolved'
    },
    (error: Error) => {
      outcome = error.message
    }
  )

  await vi.advanceTimersByTimeAsync(
    terminalTabCloseTiming.TERMINAL_TAB_CLOSE_RESPONSE_TIMEOUT_MS - ACK_MARGIN_MS
  )
  const outcomeBeforeRelayWall = outcome
  await vi.advanceTimersByTimeAsync(ACK_MARGIN_MS)
  await settled

  expect(outcomeBeforeRelayWall).toBe('terminal_tab_close_failed')
})

it('accepts successful provider proof at the nested close deadline', async () => {
  const webContents = {
    isDestroyed: () => false,
    send: vi.fn((_channel: string, request: { requestId: string; deadlineMs: number }): void => {
      const nestedCloseMs = terminalTabCloseTiming.resolveNestedTerminalTabCloseTimeoutMs(
        request.deadlineMs
      )
      setTimeout(() => {
        emitIpc(
          'ui:terminalTabCloseResponse',
          { sender: webContents },
          { requestId: request.requestId }
        )
      }, nestedCloseMs)
    })
  }

  let outcome = 'pending'
  void requestTerminalTabCloseFromRenderer(
    { isDestroyed: () => false, webContents } as never,
    'tab-with-provider-proof'
  ).then(
    () => {
      outcome = 'resolved'
    },
    (error: Error) => {
      outcome = error.message
    }
  )
  await vi.advanceTimersByTimeAsync(
    terminalTabCloseTiming.TERMINAL_TAB_CLOSE_RESPONSE_TIMEOUT_MS - 1
  )

  expect(outcome).toBe('resolved')
})
