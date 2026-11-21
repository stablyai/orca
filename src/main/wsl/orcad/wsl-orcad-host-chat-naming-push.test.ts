import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsUpdate } from '../../../shared/rpc-contract/client-ui/client-settings-params'
import type { WslOrcadHostCapabilityVerdict } from './wsl-orcad-host-environments'
import { pushWslOrcadHostChatAutoName } from './wsl-orcad-host-chat-naming-push'

describe('pushWslOrcadHostChatAutoName', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("writes the desktop's switch into a supporting host's settings", async () => {
    const written: unknown[] = []
    await pushWslOrcadHostChatAutoName(
      {
        environmentId: 'wsl-ubuntu',
        hostSupports: async () => 'supported',
        // The host's own strict settings.update schema decides what it accepts.
        call: async (method, params) => {
          written.push({ method, settings: SettingsUpdate.parse(params) })
          return { id: '1', ok: true, result: {}, _meta: { runtimeId: 'host' } }
        }
      },
      () => false
    )

    expect(written).toEqual([
      { method: 'settings.update', settings: { nativeChatAutoName: false } }
    ])
  })

  it('retries when the host could not report its capabilities yet', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const verdicts: WslOrcadHostCapabilityVerdict[] = ['unknown', 'supported']
    const written: unknown[] = []

    await pushWslOrcadHostChatAutoName(
      {
        environmentId: 'wsl-debian',
        hostSupports: async () => verdicts.shift() ?? 'supported',
        call: async (method, params) => {
          written.push({ method, params })
          return { id: '1', ok: true, result: {}, _meta: { runtimeId: 'host' } }
        }
      },
      () => false,
      [1_000]
    )
    expect(written).toEqual([])

    await vi.advanceTimersByTimeAsync(1_000)

    expect(written).toEqual([{ method: 'settings.update', params: { nativeChatAutoName: false } }])
  })
})
