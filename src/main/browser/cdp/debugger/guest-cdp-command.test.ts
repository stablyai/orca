import type { WebContents } from 'electron'
import { expect, it } from 'vitest'
import { registerAgentInputSuspension } from '../input/agent-input-injection'
import { sendGuestCdpCommand } from './guest-cdp-command'

it('delivers CDP pointer commands when a tool-key policy cannot acknowledge, but refuses keyboard input', async () => {
  const guest = {
    id: 3,
    isDestroyed: () => false,
    isCrashed: () => false,
    setIgnoreMenuShortcuts: () => {},
    isOffscreen: () => false,
    debugger: { sendCommand: async () => ({ ok: true }) }
  } as unknown as WebContents
  const unavailable = new Error('key policy unavailable')
  const dispose = registerAgentInputSuspension(guest, async () => {
    throw unavailable
  })
  try {
    await expect(
      sendGuestCdpCommand(guest, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: 20,
        y: 30
      })
    ).resolves.toEqual({ ok: true })
    await expect(
      sendGuestCdpCommand(guest, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'g'
      })
    ).rejects.toBe(unavailable)
  } finally {
    dispose()
  }
})
