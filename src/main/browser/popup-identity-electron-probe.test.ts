import { EventEmitter } from 'node:events'
import { existsSync, rmSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createPopupIdentityProbeRoot,
  launchPopupIdentityProbe
} from './popup-identity-electron-probe'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), closeBrowser: vi.fn() }))

vi.mock('@orca/process-host', () => ({ spawnProcess: mocks.spawn }))
vi.mock('playwright', () => ({
  chromium: { connectOverCDP: vi.fn(async () => ({ close: mocks.closeBrowser })) }
}))
vi.mock('./browser-session-ua-cdp-collector', () => ({
  waitForBrowserCdpEndpoint: vi.fn(async () => undefined)
}))

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

it.each([
  { exitCode: 0, signalCode: null },
  { exitCode: null, signalCode: 'SIGTERM' }
] as const)(
  'cleans up a probe whose child already exited with $exitCode / $signalCode',
  async ({ exitCode, signalCode }) => {
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      exitCode,
      signalCode,
      kill: vi.fn()
    })
    mocks.spawn.mockReturnValue(child)
    const root = createPopupIdentityProbeRoot()
    roots.push(root)
    const probe = await launchPopupIdentityProbe(root)
    child.emit('exit', exitCode, signalCode)

    await probe.stop()

    expect(mocks.closeBrowser).toHaveBeenCalledOnce()
    expect(child.listenerCount('exit')).toBe(0)
    expect(existsSync(root)).toBe(false)
  },
  2_000
)
