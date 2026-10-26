import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findInstalledBrowserMock, runProcessMock, spawnProcessMock } = vi.hoisted(() => ({
  findInstalledBrowserMock: vi.fn(),
  runProcessMock: vi.fn(),
  spawnProcessMock: vi.fn()
}))
vi.mock('./installed-browser-catalog', () => ({ findInstalledBrowser: findInstalledBrowserMock }))
vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock,
  spawnProcess: spawnProcessMock
}))

import { openUrlInInstalledBrowser } from './external-browser-launch'

const URL = 'https://example.com/?a=1&b=2'

function fakeChild(event: 'spawn' | 'error'): EventEmitter & { unref: () => void } {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  queueMicrotask(() =>
    event === 'spawn' ? child.emit('spawn') : child.emit('error', new Error('ENOENT'))
  )
  return child
}

beforeEach(() => {
  findInstalledBrowserMock.mockReset()
  runProcessMock.mockReset()
  spawnProcessMock.mockReset()
})

describe('openUrlInInstalledBrowser', () => {
  it('returns failure for an unknown browser id without spawning', async () => {
    findInstalledBrowserMock.mockResolvedValue(undefined)

    await expect(openUrlInInstalledBrowser('missing', URL)).resolves.toBe(false)
    expect(spawnProcessMock).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('spawns the browser detached with the URL as a separate argument', async () => {
    findInstalledBrowserMock.mockResolvedValue({
      id: 'firefox.desktop',
      name: 'Firefox',
      launchCommand: (url: string) => ({ program: '/usr/bin/firefox', args: ['--new-tab', url] })
    })
    spawnProcessMock.mockImplementation(() => fakeChild('spawn'))

    await expect(openUrlInInstalledBrowser('firefox.desktop', URL)).resolves.toBe(true)
    expect(spawnProcessMock).toHaveBeenCalledWith({
      program: '/usr/bin/firefox',
      args: ['--new-tab', URL],
      detached: true,
      stdio: 'ignore'
    })
  })

  it('returns failure when the executable cannot start', async () => {
    findInstalledBrowserMock.mockResolvedValue({
      id: 'Google Chrome',
      name: 'Google Chrome',
      launchCommand: (url: string) => ({ program: 'C:\\gone\\chrome.exe', args: [url] })
    })
    spawnProcessMock.mockImplementation(() => fakeChild('error'))

    await expect(openUrlInInstalledBrowser('Google Chrome', URL)).resolves.toBe(false)
  })

  it.each([
    [0, true],
    [1, false]
  ])('reports a waited launcher exiting %i as %s', async (code, expected) => {
    findInstalledBrowserMock.mockResolvedValue({
      id: 'com.google.Chrome',
      name: 'Google Chrome',
      launchCommand: (url: string) => ({
        program: '/usr/bin/open',
        args: ['-b', 'com.google.Chrome', url],
        waitForExit: true
      })
    })
    runProcessMock.mockResolvedValue({
      code,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })

    await expect(openUrlInInstalledBrowser('com.google.Chrome', URL)).resolves.toBe(expected)
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/usr/bin/open',
        args: ['-b', 'com.google.Chrome', URL]
      })
    )
  })
})
