import { beforeEach, describe, expect, it, vi } from 'vitest'

const { webContentsFromId } = vi.hoisted(() => ({ webContentsFromId: vi.fn() }))

vi.mock('electron', () => ({
  webContents: { fromId: webContentsFromId }
}))

import { CdpBridge } from './cdp-bridge'
import {
  CDP_MAX_CONSOLE_TEXT_CODE_UNITS,
  CDP_MAX_IFRAME_SESSIONS,
  CDP_MAX_PAUSED_REQUESTS
} from './cdp-event-memory-bounds'

function createHarness() {
  let attached = false
  const messageListeners: ((event: unknown, method: string, params: unknown) => void)[] = []
  const sendCommand = vi.fn(async (_method: string, _params?: unknown) => ({}))
  const guest = {
    id: 1,
    isDestroyed: () => false,
    getURL: () => 'https://example.com',
    getTitle: () => 'Example',
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      sendCommand,
      on: (event: string, listener: (event: unknown, method: string, params: unknown) => void) => {
        if (event === 'message') {
          messageListeners.push(listener)
        }
      },
      removeListener: vi.fn()
    }
  }
  const browserManager = {
    webContentsIdByTabId: new Map([['page-1', guest.id]])
  }
  const bridge = new CdpBridge(browserManager as never)
  bridge.setActiveTab(guest.id)
  return {
    bridge,
    guest,
    sendCommand,
    emit(method: string, params: unknown) {
      for (const listener of messageListeners) {
        listener({}, method, params)
      }
    }
  }
}

describe('CdpBridge event retention', () => {
  beforeEach(() => {
    webContentsFromId.mockReset()
  })

  it('bounds paused requests, iframe sessions, and console text', async () => {
    const harness = createHarness()
    webContentsFromId.mockReturnValue(harness.guest)
    const internals = harness.bridge as unknown as {
      ensureDebuggerAttached: (guest: unknown) => Promise<void>
      tabState: Map<
        string,
        {
          capturing: boolean
          intercepting: boolean
          consoleLog: { text: string }[]
          pausedRequests: Map<string, unknown>
          iframeSessions: Map<string, string>
        }
      >
    }
    await internals.ensureDebuggerAttached(harness.guest)
    const state = internals.tabState.get('page-1')!
    state.capturing = true
    state.intercepting = true

    harness.emit('Runtime.consoleAPICalled', {
      args: [{ value: 'x'.repeat(CDP_MAX_CONSOLE_TEXT_CODE_UNITS * 2) }]
    })
    for (let index = 0; index < CDP_MAX_PAUSED_REQUESTS + 10; index++) {
      harness.emit('Fetch.requestPaused', {
        requestId: `request-${index}`,
        request: { url: `https://example.com/${index}`, method: 'GET', headers: {} }
      })
    }
    for (let index = 0; index < CDP_MAX_IFRAME_SESSIONS + 1; index++) {
      harness.emit('Target.attachedToTarget', {
        sessionId: `session-${index}`,
        targetInfo: { type: 'iframe', targetId: `frame-${index}` }
      })
    }

    expect(state.consoleLog[0]?.text).toHaveLength(CDP_MAX_CONSOLE_TEXT_CODE_UNITS)
    expect(state.pausedRequests.size).toBe(CDP_MAX_PAUSED_REQUESTS)
    expect(state.iframeSessions.size).toBe(CDP_MAX_IFRAME_SESSIONS)
    expect(
      harness.sendCommand.mock.calls.filter(([method]) => method === 'Fetch.continueRequest')
    ).toHaveLength(10)
    expect(
      harness.sendCommand.mock.calls.filter(([method]) => method === 'Target.detachFromTarget')
    ).toHaveLength(1)
  })
})
