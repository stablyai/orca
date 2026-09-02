import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginLockfile } from '../../shared/plugins/plugin-install-lockfile'
import type { PluginService } from '../plugins/plugin-service'
import type { Store } from '../persistence'

const electronMocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.handle, on: electronMocks.on }
}))

import {
  canRemoveInstalledPlugin,
  parsePluginConsentArgs,
  parsePluginInstallArgs,
  registerPluginHandlers
} from './plugins'

beforeEach(() => {
  electronMocks.handle.mockReset()
  electronMocks.on.mockReset()
})

describe('plugin consent IPC schema', () => {
  it('requires the fingerprint reviewed by the caller', () => {
    expect(() =>
      parsePluginConsentArgs({ pluginKey: 'orca-samples.demo', decision: 'approve' })
    ).toThrow()
  })

  it('accepts an explicit reviewed fingerprint', () => {
    expect(
      parsePluginConsentArgs({
        pluginKey: 'orca-samples.demo',
        reviewedFingerprint: 'sha256-reviewed',
        decision: 'approve'
      })
    ).toEqual({
      pluginKey: 'orca-samples.demo',
      reviewedFingerprint: 'sha256-reviewed',
      decision: 'approve'
    })
  })
})

describe('plugin install IPC schema', () => {
  it('requires a non-empty git ref', () => {
    expect(() =>
      parsePluginInstallArgs({ kind: 'git', url: 'https://example.com/plugin.git' })
    ).toThrow()
    expect(() =>
      parsePluginInstallArgs({ kind: 'git', url: 'https://example.com/plugin.git', ref: '   ' })
    ).toThrow()
  })

  it('accepts an explicit git ref', () => {
    expect(
      parsePluginInstallArgs({
        kind: 'git',
        url: 'https://example.com/plugin.git',
        ref: ' v1.2.3 '
      })
    ).toEqual({ kind: 'git', url: 'https://example.com/plugin.git', ref: 'v1.2.3' })
  })

  it('accepts HTTPS and SSH git transports', () => {
    expect(
      parsePluginInstallArgs({
        kind: 'git',
        url: 'ssh://git@example.com/acme/plugin.git',
        ref: 'main'
      })
    ).toEqual({
      kind: 'git',
      url: 'ssh://git@example.com/acme/plugin.git',
      ref: 'main'
    })
    expect(
      parsePluginInstallArgs({
        kind: 'git',
        url: 'git@example.com:acme/plugin.git',
        ref: 'main'
      })
    ).toEqual({ kind: 'git', url: 'git@example.com:acme/plugin.git', ref: 'main' })
  })

  it('rejects executable helpers and embedded HTTPS credentials', () => {
    expect(() =>
      parsePluginInstallArgs({ kind: 'git', url: 'ext::sh -c calc', ref: 'main' })
    ).toThrow()
    expect(() =>
      parsePluginInstallArgs({
        kind: 'git',
        url: 'https://user@example.com/plugin.git',
        ref: 'main'
      })
    ).toThrow()
  })
})

describe('plugin removal authority', () => {
  it('allows installed rows but refuses dev overrides and unknown keys', () => {
    const service = {
      getDiscovered: () => [
        { pluginKey: 'orca-samples.installed', isDev: false },
        { pluginKey: 'orca-samples.dev', isDev: true }
      ]
    } as unknown as PluginService

    expect(canRemoveInstalledPlugin(service, 'orca-samples.installed')).toBe(true)
    expect(canRemoveInstalledPlugin(service, 'orca-samples.dev')).toBe(false)
    expect(canRemoveInstalledPlugin(service, 'orca-samples.unknown')).toBe(false)
  })

  it('refuses bundled installs because startup would restore them', () => {
    const service = {
      getDiscovered: () => [{ pluginKey: 'stablyai.orca-theme', isDev: false }]
    } as unknown as PluginService
    const lock = {
      version: 1,
      plugins: {
        'stablyai.orca-theme': {
          pluginKey: 'stablyai.orca-theme',
          version: '1.0.0',
          source: { kind: 'bundled', bundleId: 'stablyai.orca-theme' },
          resolvedCommit: null,
          contentHash: 'a'.repeat(64),
          consentFingerprint: 'reviewed',
          installedAt: 1
        }
      }
    } satisfies PluginLockfile

    expect(canRemoveInstalledPlugin(service, 'stablyai.orca-theme', lock)).toBe(false)
  })
})

describe('plugin settings lifecycle authority', () => {
  it('refreshes from the main-process settings listener without renderer follow-up', () => {
    let settingsListener!: (updates: {
      pluginSystemEnabled?: boolean
      devPluginPaths?: string[]
    }) => void
    const store = {
      onSettingsChanged: vi.fn((listener) => {
        settingsListener = listener
        return vi.fn()
      })
    } as unknown as Store
    const service = {
      setRuntimeDelegate: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined)
    } as unknown as PluginService
    registerPluginHandlers(store, service, null)

    settingsListener({ pluginSystemEnabled: false })

    expect(service.refresh).toHaveBeenCalledOnce()
  })
})
