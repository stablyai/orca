import { describe, expect, it } from 'vitest'
import { SettingsUpdate } from '../../../shared/rpc-contract/client-ui/client-settings-params'
import { pushWslOrcadHostChatAutoName } from './wsl-orcad-host-chat-naming-push'

describe('pushWslOrcadHostChatAutoName', () => {
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
})
