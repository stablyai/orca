import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ Notification: {}, nativeImage: {} }))
vi.mock('../../../window/foreground-activation-policy', () => ({ isBackgroundLaunch: () => true }))
vi.mock('../browser-extension-api-host', () => ({ emitBrowserExtensionEvent: vi.fn() }))
vi.mock('./permissions', () => ({ noteBrowserExtensionUserGesture: vi.fn() }))

const { resolveNotificationIconPath } = await import('./notifications')

const extension = { id: 'a'.repeat(32), path: join('/ext', 'root') }

describe('resolveNotificationIconPath', () => {
  it("resolves the extension's own icons, relative or absolute", () => {
    const icon = join(extension.path, 'icons', 'bell.png')
    expect(resolveNotificationIconPath(extension, 'icons/bell.png')).toBe(icon)
    expect(
      resolveNotificationIconPath(extension, `chrome-extension://${extension.id}/icons/bell.png`)
    ).toBe(icon)
  })

  it('refuses icons from the web, other extensions, or outside the package', () => {
    expect(resolveNotificationIconPath(extension, 'https://site.test/bell.png')).toBeNull()
    expect(
      resolveNotificationIconPath(extension, `chrome-extension://${'b'.repeat(32)}/bell.png`)
    ).toBeNull()
    expect(resolveNotificationIconPath(extension, 'icons%2F..%2F..%2Fsecret.png')).toBeNull()
  })
})
