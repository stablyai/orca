import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'

import { browserCaptureIdle } from './browser-capture-idle'
import { CdpPageNavigationCommands } from './cdp-page-navigation-commands'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the response writer fixture only checks this client's identity and never performs socket I/O.
const client = {} as WebSocket

function createReloadFixture() {
  const guest = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn()
  })
  const responder = { isActiveClient: vi.fn(() => true), sendError: vi.fn(), sendResult: vi.fn() }
  const sessions = { resolveDebuggerSessionId: vi.fn(() => undefined) }
  const channel = { sendDebuggerCommand: vi.fn(async () => ({})), forwardCommand: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these bounded fixtures supply every dependency member used by root reload and its lifecycle priming.
  const dependencies = [guest, responder, sessions, channel] as unknown as ConstructorParameters<
    typeof CdpPageNavigationCommands
  >
  return { guest, responder, commands: new CdpPageNavigationCommands(...dependencies) }
}

describe('root CDP reload capture admission', () => {
  it('does not retain a capture lease while a page loads after root reload returns', async () => {
    const { guest, commands } = createReloadFixture()
    await commands.reloadWithLifecycle(client, 1, {})
    expect(guest.reload).toHaveBeenCalledTimes(1)
    // reload() is intentionally fire-and-forget: it should not retain a capture
    // lease waiting for a network/navigation event that may never arrive.
    expect(browserCaptureIdle.isIdle(guest)).toBe(true)
    const lease = await browserCaptureIdle.reserve(guest)
    lease.release()
  })

  it('does not invoke root reload while an owned transition reserves the guest', async () => {
    const { guest, commands, responder } = createReloadFixture()
    const lease = await browserCaptureIdle.reserve(guest)

    await commands.reloadWithLifecycle(client, 1, {})
    expect(guest.reload).not.toHaveBeenCalled()
    expect(responder.sendError).toHaveBeenCalled()
    lease.release()
  })
})
