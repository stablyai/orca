import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventSchemas } from '../../shared/telemetry-events'
import {
  pluginInstallKind,
  pluginTelemetryCatalog,
  trackPluginInstalled
} from './plugin-install-telemetry'

const telemetry = vi.hoisted(() => ({ track: vi.fn() }))
vi.mock('./client', () => telemetry)

beforeEach(() => {
  telemetry.track.mockReset()
})

describe('plugin install telemetry', () => {
  it('names only the official and community catalogs', () => {
    expect(pluginTelemetryCatalog('https://github.com/stablyai/orca-plugins.git')).toBe('official')
    expect(pluginTelemetryCatalog('git@github.com:stablyai/orca-plugins.git')).toBe('official')
    expect(pluginTelemetryCatalog('https://github.com/stablyai/orca-community-plugins')).toBe(
      'community'
    )
    expect(pluginTelemetryCatalog('https://github.com/acme/private-plugins.git')).toBeNull()
    expect(
      pluginTelemetryCatalog('https://gitlab.example.com/stablyai/orca-plugins.git')
    ).toBeNull()
  })

  it('tells a first install from a reinstall and an update', () => {
    expect(pluginInstallKind(null, '1.0.0')).toBe('install')
    expect(pluginInstallKind('1.0.0', '1.0.0')).toBe('reinstall')
    expect(pluginInstallKind('1.0.0', '1.1.0')).toBe('update')
  })

  it('sends nothing for a private catalog install', () => {
    trackPluginInstalled({
      marketplaceUrl: 'https://github.com/acme/private-plugins.git',
      plugin_key: 'acme.notes',
      version: '1.0.0',
      kind: 'install',
      trigger: 'catalog'
    })
    expect(telemetry.track).not.toHaveBeenCalled()
  })

  it('never lets a telemetry failure escape', () => {
    telemetry.track.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() =>
      trackPluginInstalled({
        marketplaceUrl: 'https://github.com/stablyai/orca-plugins.git',
        plugin_key: 'acme.notes',
        version: '1.0.0',
        kind: 'install',
        trigger: 'catalog'
      })
    ).not.toThrow()
    expect(telemetry.track).toHaveBeenCalledOnce()
  })

  it('schemas reject anything but a plugin key and enums', () => {
    const valid = {
      plugin_key: 'acme.notes',
      version: '1.2.0-beta.1',
      catalog: 'official',
      kind: 'install',
      trigger: 'catalog'
    }
    expect(eventSchemas.plugin_installed.safeParse(valid).success).toBe(true)
    for (const bad of [
      { ...valid, plugin_key: '/Users/me/dev-plugin' },
      { ...valid, plugin_key: 'notes' },
      { ...valid, catalog: 'dev' },
      { ...valid, version: '1.0.0 /tmp' },
      { ...valid, path: '/Users/me' }
    ]) {
      expect(eventSchemas.plugin_installed.safeParse(bad).success).toBe(false)
    }
  })
})
