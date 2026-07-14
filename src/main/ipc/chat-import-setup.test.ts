import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/userdata' },
  ipcMain: { handle: vi.fn() }
}))

import { CHAT_IMPORT_EXTENSION_ID } from '../chat-import/chat-import-extension'
import { buildSetupStatus, resolveInstall } from './chat-import-setup'

const baseDeps = {
  platform: 'darwin' as NodeJS.Platform,
  homeDir: '/Users/u',
  userDataPath: '/data',
  extensionDir: '/app/extensions/chat-import',
  lastSynced: { CHATGPT: null, CLAUDE: null, GEMINI: null }
}

describe('buildSetupStatus', () => {
  it('returns all four browsers with their display labels', () => {
    const status = buildSetupStatus({
      ...baseDeps,
      exists: () => false,
      registryHas: () => false
    })
    expect(status.browsers.map((b) => b.id)).toEqual(['chrome', 'edge', 'brave', 'chromium'])
    expect(status.browsers.map((b) => b.label)).toEqual(['Chrome', 'Edge', 'Brave', 'Chromium'])
  })

  it('reflects the injected exists() as detected per-browser', () => {
    const status = buildSetupStatus({
      ...baseDeps,
      exists: (p) => p.includes('Google/Chrome'),
      registryHas: () => false
    })
    const chrome = status.browsers.find((b) => b.id === 'chrome')
    const edge = status.browsers.find((b) => b.id === 'edge')
    expect(chrome?.detected).toBe(true)
    expect(edge?.detected).toBe(false)
  })

  it('reflects the injected exists() as hostInstalled per-browser on posix', () => {
    const status = buildSetupStatus({
      ...baseDeps,
      exists: (p) => p.endsWith('com.orca.chatimport.json'),
      registryHas: () => false
    })
    expect(status.browsers.every((b) => b.hostInstalled)).toBe(true)
  })

  it('reflects the injected registryHas() as hostInstalled per-browser on win32', () => {
    const status = buildSetupStatus({
      ...baseDeps,
      platform: 'win32',
      exists: () => false,
      registryHas: (k) => k.includes('NativeMessagingHosts')
    })
    expect(status.browsers.every((b) => b.hostInstalled)).toBe(true)
  })

  it('passes lastSynced through as lastSyncedBySource', () => {
    const lastSynced = { CHATGPT: '2026-01-01T00:00:00Z', CLAUDE: null, GEMINI: null }
    const status = buildSetupStatus({
      ...baseDeps,
      lastSynced,
      exists: () => false,
      registryHas: () => false
    })
    expect(status.lastSyncedBySource).toEqual(lastSynced)
  })

  it('passes extensionDir through untouched', () => {
    const status = buildSetupStatus({
      ...baseDeps,
      exists: () => false,
      registryHas: () => false
    })
    expect(status.extensionDir).toBe('/app/extensions/chat-import')
  })
})

describe('resolveInstall', () => {
  it('calls install with the fixed extension id and resolved exec command', () => {
    const installSpy = vi.fn(() => ({ launcherPath: '/launcher', manifestPath: '/manifest' }))
    const runRegistry = vi.fn()
    const result = resolveInstall('chrome', {
      platform: 'darwin',
      homeDir: '/Users/u',
      userDataPath: '/data',
      cliEntry: '/app/out/cli/index.js',
      execPath: '/usr/bin/node',
      runRegistry,
      install: installSpy
    })

    expect(installSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'darwin',
        homeDir: '/Users/u',
        userDataPath: '/data',
        browser: 'chrome',
        extensionId: CHAT_IMPORT_EXTENSION_ID,
        execCommand: { command: '/usr/bin/node', args: ['/app/out/cli/index.js'] },
        runRegistry
      })
    )
    expect(result).toEqual({ launcherPath: '/launcher', manifestPath: '/manifest' })
  })

  it('forwards the requested browser through to install', () => {
    const installSpy = vi.fn(() => ({ launcherPath: '/l', manifestPath: '/m' }))
    resolveInstall('edge', {
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      userDataPath: 'C:\\data',
      cliEntry: 'C:\\app\\out\\cli\\index.js',
      execPath: 'C:\\node.exe',
      runRegistry: vi.fn(),
      install: installSpy
    })
    expect(installSpy).toHaveBeenCalledWith(expect.objectContaining({ browser: 'edge' }))
  })
})
