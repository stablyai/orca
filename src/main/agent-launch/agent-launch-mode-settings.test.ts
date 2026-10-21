import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { decideAgentLaunchMode, readAgentLaunchModeSettings } from './agent-launch-mode'

vi.mock('electron', () => ({ app: { getPath: () => '/orca-state', isPackaged: true } }))

describe('host launch preference ownership', () => {
  it.each([false, true])('reads saved choices privately with Agents disabled=%s', (disabled) => {
    const settings: ReturnType<RuntimeStore['getSettings']> = {
      ...getDefaultSettings('/tmp'),
      experimentalNativeChat: true,
      nativeChatProviders: { claude: false },
      disabledTuiAgents: disabled ? ['claude'] : []
    }
    const store = { getSettings: () => settings }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: construction and these readers use only getSettings from the fixture.
    const runtime = new OrcaRuntimeService(store as RuntimeStore)
    expect(runtime.getClientSettings()).not.toHaveProperty('nativeChatProviders')
    const mode = decideAgentLaunchMode({
      placement: { agent: 'claude' },
      settings: readAgentLaunchModeSettings(runtime)
    })
    expect(mode.mode).toBe('terminal')
  })

  it('keeps an unchosen provider on without discovering installed agents', () => {
    const saved = { experimentalNativeChat: true }
    const runtime = { requireStore: () => ({ getSettings: () => saved }) }
    expect(
      decideAgentLaunchMode({
        placement: { agent: 'grok' },
        settings: readAgentLaunchModeSettings(runtime)
      }).mode
    ).toBe('structured')
    expect(saved).not.toHaveProperty('nativeChatProviders')
  })

  it.each([false, true])('preserves desktop stamp %s against opposite host choices', (stamp) => {
    const runtime = {
      requireStore: () => ({
        getSettings: () => ({
          experimentalNativeChat: !stamp,
          nativeChatProviders: { grok: !stamp }
        })
      })
    }
    const mode = decideAgentLaunchMode({
      placement: { agent: 'grok' },
      settings: readAgentLaunchModeSettings(runtime, stamp)
    })
    expect(mode.mode).toBe(stamp ? 'structured' : 'terminal')
  })
})
