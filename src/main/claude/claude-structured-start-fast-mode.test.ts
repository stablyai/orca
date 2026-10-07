// A saved Fast the launch leaves out beside the agent Arguments' own `--settings`, applied by the
// start once the child answers.

import { expect, it, vi } from 'vitest'
import { adapterFor, fakeClaude, identityFor } from './claude-structured-session-test-support'

it("applies a resumed conversation's saved Fast off after start beside the Arguments' settings", async () => {
  const claude = fakeClaude({
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
  await vi.waitFor(() =>
    expect(claude.connections[0].calls.at(-1)).toEqual({
      subtype: 'apply_flag_settings',
      params: { settings: { fastMode: false } }
    })
  )
})
