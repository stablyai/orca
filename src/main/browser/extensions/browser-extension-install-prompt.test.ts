import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_EXTENSION_INSTALL_PROMPT_CLOSED_CHANNEL,
  BROWSER_EXTENSION_INSTALL_PROMPT_REQUESTED_CHANNEL
} from '../../../shared/browser-extension-webstore'
import {
  requestBrowserExtensionInstallPrompt,
  respondToBrowserExtensionInstallPrompt
} from './browser-extension-install-prompt'

describe('extension permission prompt lifetime', () => {
  it('closes a cancelled prompt and refuses a late acceptance', async () => {
    const renderer = Object.assign(new EventEmitter(), {
      id: 41,
      isDestroyed: () => false,
      send: vi.fn<(channel: string, payload: { requestId: string }) => void>()
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prompt uses only EventEmitter, id, isDestroyed and send on this renderer.
    const contents = renderer as unknown as Electron.WebContents
    const lifetime = new AbortController()
    const pending = requestBrowserExtensionInstallPrompt(
      contents,
      {
        kind: 'permissions',
        name: 'Example',
        iconDataUrl: null,
        permissions: ['privacy'],
        hostPermissions: [],
        profileLabel: 'Work'
      },
      undefined,
      lifetime.signal
    )
    const requested = renderer.send.mock.calls.find(
      ([channel]) => channel === BROWSER_EXTENSION_INSTALL_PROMPT_REQUESTED_CHANNEL
    )?.[1]
    if (!requested) {
      throw new Error('Prompt was not presented')
    }
    lifetime.abort()
    const acceptedLate = respondToBrowserExtensionInstallPrompt(contents, {
      requestId: requested.requestId,
      accepted: true
    })
    expect(acceptedLate).toBe(false)
    await expect(pending).resolves.toBe(false)
    expect(renderer.send).toHaveBeenLastCalledWith(
      BROWSER_EXTENSION_INSTALL_PROMPT_CLOSED_CHANNEL,
      { requestId: requested.requestId }
    )
  })
})
