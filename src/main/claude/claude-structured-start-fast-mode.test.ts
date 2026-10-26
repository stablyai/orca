import { expect, it, vi } from 'vitest'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  claudeOpened,
  USER_MESSAGE
} from './claude-structured-session-test-support'

it("applies a resumed conversation's saved Fast off before message input beside the Arguments' settings", async () => {
  let fastMode = true
  const claude = fakeClaude({
    routes: {
      apply_flag_settings: () => {
        fastMode = false
      }
    },
    settings: { effective: { fastMode: true, fastModePerSessionOptIn: false } }
  })
  const adapter = adapterFor(claude, {
    resumesTranscript: true,
    continuesChain: true,
    options: { extraArgs: { settings: '/repo/claude.json' } }
  })

  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    options: { fastMode: 'false' }
  })

  expect(claude.connections[0].launch.options).not.toHaveProperty('settings')
  expect(claude.connections[0].launch.options.extraArgs).toEqual({
    settings: '/repo/claude.json'
  })
  await claudeOpened(adapter, 'session-1')
  claude.connections[0].getSettings = async () => ({
    effective: { fastMode, fastModePerSessionOptIn: false }
  })
  await expect(
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'message-fast',
      body: USER_MESSAGE,
      executionOptions: { fastMode: 'false' },
      fence: 7
    })
  ).resolves.toMatchObject({ state: 'admitted' })
  await vi.waitFor(() =>
    expect(
      claude.connections[0].calls.find((call) => call.subtype === 'apply_flag_settings')
    ).toEqual({
      subtype: 'apply_flag_settings',
      params: { settings: { fastMode: false } }
    })
  )
})
