import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import {
  NATIVE_CHAT_VISUAL_GUEST_THEME_READ as READ,
  NATIVE_CHAT_VISUAL_GUEST_THEME_UPDATE as UPDATE
} from '../shared/native-chat/native-chat-visual-shell'

const preload = buildSync({
  entryPoints: [fileURLToPath(new URL('./native-chat-visual-guest-theme.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  write: false
}).outputFiles[0].text

afterEach(() => vi.restoreAllMocks())
describe('visual guest preload', () => {
  it('installs initial CSS synchronously and changes appearance without replacing page state', () => {
    const callbacks = new Map<string, (...args: unknown[]) => void>()
    const theme = { css: ':root{--background:#111}', colorScheme: 'dark' }
    const ipc = {
      sendSync: vi.fn(() => theme),
      on: vi.fn((name, callback) => callbacks.set(name, callback))
    }
    const frame = { insertCSS: vi.fn(() => 'style-key'), removeInsertedCSS: vi.fn() }
    const input = { value: 'keep this' }
    const root = { classList: { toggle: vi.fn() } }
    const document: { documentElement: typeof root | null; input: typeof input } = {
      documentElement: null,
      input
    }
    let onRoot: () => void = () => {}
    const disconnect = vi.fn()
    const observer = vi.fn()
    const module = {
      exports: { installNativeChatVisualGuestTheme: vi.fn() }
    }
    runInNewContext(preload, {
      module,
      exports: module.exports,
      process: { isMainFrame: true },
      location: { href: 'file:///profile/chat-scratch/session/mock.html' },
      document,
      MutationObserver: class {
        constructor(callback: () => void) {
          onRoot = callback
        }
        observe = observer
        disconnect = disconnect
      }
    })
    module.exports.installNativeChatVisualGuestTheme(ipc, frame)
    expect(ipc.sendSync).toHaveBeenCalledExactlyOnceWith(READ)
    expect(frame.insertCSS).toHaveBeenCalledExactlyOnceWith(theme.css, { cssOrigin: 'author' })
    document.documentElement = root
    onRoot()
    expect(root.classList.toggle).toHaveBeenCalledWith('dark', true)
    expect(disconnect).toHaveBeenCalledTimes(1)
    callbacks.get(UPDATE)!({}, { css: ':root{--background:#fff}', colorScheme: 'light' })
    expect(frame.removeInsertedCSS).toHaveBeenCalledWith('style-key')
    expect(root.classList.toggle).toHaveBeenLastCalledWith('dark', false)
    expect(document.input).toBe(input)
    expect(input.value).toBe('keep this')
  })

  it.each([
    [false, 'file:///mock.html'],
    [true, 'https://example.com/']
  ])('does not request appearance for unrelated contexts', (isMainFrame, href) => {
    const module = {
      exports: { installNativeChatVisualGuestTheme: vi.fn() }
    }
    runInNewContext(preload, {
      module,
      exports: module.exports,
      process: { isMainFrame },
      location: { href }
    })
    const sendSync = vi.fn()
    module.exports.installNativeChatVisualGuestTheme({ sendSync }, {})
    expect(sendSync).not.toHaveBeenCalled()
  })
})
