import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'
import { describe, expect, it, vi } from 'vitest'
import { codexNextPromptConfig } from './codex-next-prompt-instructions'

describe('Codex next prompt instructions', () => {
  it('preserves the effective user instructions and does not duplicate its own instructions', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ config: { developer_instructions: 'Keep my rules.' } })
    const result = await codexNextPromptConfig({ request }, '/workspace', undefined)
    expect(result.developer_instructions).toEqual(expect.stringContaining('Keep my rules.\n\n'))
    expect(result.developer_instructions).toEqual(
      expect.stringContaining('Never execute a suggestion')
    )
    expect(request).toHaveBeenCalledWith('config/read', { cwd: '/workspace' }, { timeoutMs: 2000 })
    expect(await codexNextPromptConfig({ request }, '/workspace', result)).toEqual(result)
  })

  it('prefers explicit thread overrides', async () => {
    const request = vi.fn().mockResolvedValue({ config: { developer_instructions: 'Global.' } })
    const result = await codexNextPromptConfig({ request }, '/workspace', {
      developer_instructions: 'Thread.'
    })
    expect(result.developer_instructions).toEqual(expect.stringContaining('Thread.\n\n'))
    expect(result.developer_instructions).not.toEqual(expect.stringContaining('Global.'))
  })

  it.each([{}, { config: null }, { config: { developer_instructions: 123 } }])(
    'does not replace unreadable instructions',
    async (response) => {
      expect(
        await codexNextPromptConfig(
          { request: vi.fn().mockResolvedValue(response) },
          '/workspace',
          undefined
        )
      ).toEqual({})
    }
  )

  it('degrades without breaking chat when config is unsupported or times out', async () => {
    expect(
      await codexNextPromptConfig(
        { request: vi.fn().mockRejectedValue(new Error('timeout')) },
        '/workspace',
        undefined
      )
    ).toEqual({})
  })
})

describe('next prompt thread setup', () => {
  it('adds suggestions to new threads while preserving user instructions', async () => {
    const codex = fakeCodex({
      'config/read': () => ({ config: { developer_instructions: 'My existing instructions.' } })
    })
    const adapter = adapterFor(codex)
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 1,
      spawnToken: 'spawn-1'
    })
    expect(
      codex.connections[0].calls.find((call) => call.method === 'thread/start')?.params?.config
    ).toMatchObject({
      developer_instructions: expect.stringContaining(
        'My existing instructions.\n\nOrca native chat'
      )
    })
  })

  it('does not replace the saved instructions when resuming a thread', async () => {
    const codex = fakeCodex()
    const adapter = adapterFor(codex, { resumeThreadId: 'thread-saved' })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 1,
      spawnToken: 'spawn-1'
    })
    const resumeIndex = codex.connections[0].calls.findIndex(
      (call) => call.method === 'thread/resume'
    )
    expect(resumeIndex).toBeGreaterThan(0)
    expect(
      codex.connections[0].calls.slice(0, resumeIndex).some((call) => call.method === 'config/read')
    ).toBe(false)
    expect(
      codex.connections[0].calls.find((call) => call.method === 'thread/resume')?.params?.config ??
        {}
    ).not.toHaveProperty('developer_instructions')
  })
})
