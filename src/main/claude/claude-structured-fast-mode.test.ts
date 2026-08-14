import { describe, expect, it } from 'vitest'
import {
  acquired,
  adapterFor,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'
import { claudeFastModeDescriptor } from './claude-structured-fast-mode'

const models = [
  { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', supportsFastMode: true },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsFastMode: false
  }
]

describe('Claude structured Fast mode', () => {
  it('reports, switches and restores Fast without dispatching a user turn or changing model', async () => {
    let enabled = false
    const claude = fakeClaude({
      initModel: 'claude-opus-5',
      routes: {
        list_models: () => models,
        reinitialize: () => ({
          fast_mode_state: enabled ? 'on' : 'off',
          ...(enabled ? {} : { fast_mode_disabled_reason: 'sdk_opt_in_required' })
        }),
        apply_flag_settings: (params) => {
          enabled = (params!.settings as { fastMode: boolean }).fastMode
        }
      }
    })
    const adapter = await acquired(claude)
    const options = () => adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    const before = await options()
    expect(before.descriptors?.find((entry) => entry.id === 'fastMode')).toMatchObject({
      kind: { type: 'boolean', currentValue: false },
      settable: true
    })
    const saved = await adapter.setOption({
      sessionId: 'session-1',
      fence: 7,
      key: 'fastMode',
      value: 'true'
    })
    expect(saved).toMatchObject({ fastMode: 'true' })
    expect((await options()).descriptors?.find((entry) => entry.id === 'fastMode')).toMatchObject({
      kind: { currentValue: true },
      valueSource: 'reported'
    })
    expect(adapter.readContext('session-1')?.fastMode).toBe(true)
    expect(claude.connections[0]!.sent).toEqual([])
    expect(claude.connections[0]!.calls.some((call) => call.subtype === 'set_model')).toBe(false)
    await adapter.closeAll()

    enabled = false
    const restored = adapterFor(claude)
    await restored.acquire({
      identity: identityFor(),
      fence: 8,
      spawnToken: 'restored',
      options: saved ?? {}
    })
    expect(enabled).toBe(true)
    expect(restored.readContext('session-1')?.fastMode).toBe(true)
    await restored.setOption({ sessionId: 'session-1', fence: 8, key: 'fastMode', value: 'false' })
    expect(enabled).toBe(false)
    expect(restored.readContext('session-1')?.fastMode).toBe(false)
    await restored.closeAll()
  })

  it.each(['yes', '1', '', 'TRUE'])(
    'rejects invalid boolean %j before sending a control request',
    async (value) => {
      const claude = fakeClaude()
      const adapter = await acquired(claude)
      await expect(
        adapter.setOption({ sessionId: 'session-1', fence: 7, key: 'fastMode', value })
      ).rejects.toThrow('must be true or false')
      expect(
        claude.connections[0]!.calls.some((call) => call.subtype === 'apply_flag_settings')
      ).toBe(false)
      await adapter.closeAll()
    }
  )

  it('does not confirm a successful control response when the provider kept Fast off', async () => {
    const claude = fakeClaude({
      routes: {
        reinitialize: () => ({
          fast_mode_state: 'off',
          fast_mode_disabled_reason: 'extra_usage_disabled'
        })
      }
    })
    const adapter = await acquired(claude)
    await expect(
      adapter.setOption({ sessionId: 'session-1', fence: 7, key: 'fastMode', value: 'true' })
    ).rejects.toThrow('extra_usage_disabled')
    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(result.descriptors?.find((entry) => entry.id === 'fastMode')).toMatchObject({
      kind: { currentValue: false },
      settable: false
    })
    await adapter.closeAll()
  })

  it('keeps cooldown distinguishable from off and allows disabling it', () => {
    expect(claudeFastModeDescriptor({ state: 'cooldown', reason: null }, true)).toMatchObject({
      kind: { currentValue: true },
      description: expect.stringContaining('cooldown'),
      settable: true
    })
    expect(claudeFastModeDescriptor({ state: 'off', reason: null }, false)).toMatchObject({
      settable: false
    })
    expect(
      claudeFastModeDescriptor({ state: 'on', reason: 'model_not_allowed' }, false)
    ).toMatchObject({ settable: true })
    expect(claudeFastModeDescriptor(null, true)).toMatchObject({
      kind: { type: 'boolean' },
      valueSource: 'unknown'
    })
    expect(claudeFastModeDescriptor(null, true)?.kind.currentValue).toBeUndefined()
  })
})
