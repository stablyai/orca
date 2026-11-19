import { expect, it } from 'vitest'
import { shouldHandOffServeDesktopActivation } from './macos-desktop-handoff'

const host = {
  platform: 'darwin' as const,
  isPackaged: true,
  isServeMode: true,
  homeDir: '/Users/me',
  userDataPath: '/Users/me/Library/Application Support/orca-server'
}

it('hands an independent server’s desktop activation to the desktop profile', () => {
  expect(shouldHandOffServeDesktopActivation(host)).toBe(true)
})

it('keeps an ordinary desktop activation in its own process', () => {
  expect(shouldHandOffServeDesktopActivation({ ...host, isServeMode: false })).toBe(false)
})

it('keeps the existing same-profile serve-to-desktop promotion', () => {
  expect(
    shouldHandOffServeDesktopActivation({
      ...host,
      userDataPath: '/Users/me/Library/Application Support/orca'
    })
  ).toBe(false)
})

it('leaves non-Mac serve activation unchanged', () => {
  expect(shouldHandOffServeDesktopActivation({ ...host, platform: 'linux' })).toBe(false)
})

it('leaves a development desktop’s launch policy unchanged', () => {
  expect(shouldHandOffServeDesktopActivation({ ...host, isPackaged: false })).toBe(false)
})
