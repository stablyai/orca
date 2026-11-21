import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') {
        return '/Users/me'
      }
      throw new Error('Unexpected app path lookup')
    }
  },
  BaseWindow: class {}
}))
import { shouldHandOffServeDesktopActivation } from './macos-desktop-handoff'

const host = {
  platform: 'darwin' as const,
  isPackaged: true,
  isServeMode: true,
  userDataPath: '/Users/me/Library/Application Support/orca-server'
}

it('hands an independent server’s desktop activation to the desktop profile', async () => {
  expect(await shouldHandOffServeDesktopActivation(host)).toBe(true)
})

it('keeps an ordinary desktop activation in its own process', async () => {
  expect(await shouldHandOffServeDesktopActivation({ ...host, isServeMode: false })).toBe(false)
})

it('keeps the existing same-profile serve-to-desktop promotion', async () => {
  expect(
    await shouldHandOffServeDesktopActivation({
      ...host,
      userDataPath: '/Users/me/Library/Application Support/orca'
    })
  ).toBe(false)
})

it('leaves non-Mac serve activation unchanged', async () => {
  expect(await shouldHandOffServeDesktopActivation({ ...host, platform: 'linux' })).toBe(false)
})

it('leaves a development desktop’s launch policy unchanged', async () => {
  expect(await shouldHandOffServeDesktopActivation({ ...host, isPackaged: false })).toBe(false)
})
