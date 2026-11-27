import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type * as GuestExecution from '../../../element-grab/grab-guest-execution'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  WebContentsView: class {},
  app: { getPath: () => '/downloads' },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: () => null }
}))
// The key handshake is held so the test can supersede the arm in the middle of it.
const keys = vi.hoisted(() => ({
  release: (_enabled: boolean) => {},
  started: false,
  stopped: false
}))
vi.mock('../../../element-grab/grab-native-key-session', () => ({
  GrabNativeKeySession: class {
    setEnabled(): Promise<boolean> {
      keys.started = true
      return new Promise((resolve) => {
        keys.release = resolve
      })
    }
    stop(): void {
      keys.stopped = true
    }
  }
}))
vi.mock('../../../cdp/input/agent-input-injection', () => ({
  isAgentInjectingKeyboard: () => false,
  recoverBrowserInputGuard: async () => true
}))
const retired = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../element-grab/grab-guest-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof GuestExecution>()
  return {
    ...actual,
    executeGrabScript: async () => true,
    retireGrabOverlay: () => {
      retired.count++
    }
  }
})

const { BrowserManager } = await import('../browser-manager')

it('an arm superseded during its key handshake retires its picker and key session', async () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setGrabMode and the document scope read only id, isDestroyed and events here; scripts and keys are mocked.
  const guest = Object.assign(new EventEmitter(), {
    id: 9,
    isDestroyed: () => false
  }) as unknown as Electron.WebContents
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked key session never touches its host.
  const host = { id: 1 } as unknown as Electron.WebContents
  const abort = new AbortController()
  const arm = new BrowserManager().setGrabMode('page', true, guest, host, () => true, abort.signal)
  await vi.waitFor(() => expect(keys.started).toBe(true))
  // A successor request aborts this arm, then is itself cancelled before it ever runs.
  abort.abort()
  keys.release(true)
  await expect(arm).resolves.toBe(false)
  expect(retired.count).toBe(1)
  expect(keys.stopped).toBe(true)
})
