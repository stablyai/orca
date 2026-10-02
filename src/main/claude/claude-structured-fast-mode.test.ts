import { describe, expect, it } from 'vitest'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'
import {
  acquired,
  adapterFor,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'

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
        get_settings: () => ({
          applied: { model: 'claude-opus-5' },
          effective: { fastMode: enabled }
        }),
        apply_flag_settings: (params) => {
          if (!isRecord(params?.settings) || typeof params.settings.fastMode !== 'boolean') {
            throw new Error('Expected a Fast mode setting')
          }
          enabled = params.settings.fastMode
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
      ).rejects.toThrow('no session option named fastMode')
      expect(
        claude.connections[0]!.calls.some((call) => call.subtype === 'apply_flag_settings')
      ).toBe(false)
      await adapter.closeAll()
    }
  )

  it('does not confirm a successful control response when the provider kept Fast off', async () => {
    const claude = fakeClaude({
      initModel: 'claude-opus-5',
      routes: {
        list_models: () => models,
        get_settings: () => ({
          applied: { model: 'claude-opus-5' },
          effective: { fastMode: false }
        })
      }
    })
    const adapter = await acquired(claude)
    await expect(
      adapter.setOption({ sessionId: 'session-1', fence: 7, key: 'fastMode', value: 'true' })
    ).resolves.toMatchObject({ fastMode: 'false' })
    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(result.descriptors?.find((entry) => entry.id === 'fastMode')).toMatchObject({
      kind: { currentValue: false }
    })
    await adapter.closeAll()
  })
})
