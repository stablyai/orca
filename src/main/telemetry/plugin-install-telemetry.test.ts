import { beforeEach, describe, expect, it, vi } from 'vitest'
import { trackPluginInstalled } from './plugin-install-telemetry'

const telemetry = vi.hoisted(() => ({ track: vi.fn() }))
vi.mock('./client', () => telemetry)

beforeEach(() => {
  telemetry.track.mockReset()
})

describe('plugin install telemetry', () => {
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
})
