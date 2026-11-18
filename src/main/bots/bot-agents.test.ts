import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_AGENTS } from '../../shared/agent-launch/permissions/agent-chat-permission-support'
import { BOT_AGENTS, BOT_HELD_BACK_AGENTS } from '../../shared/bot-types'
import { ACP_LAUNCH_SPECS } from '../acp/launch/acp-launch-registry'

describe('the agents a bot can run on', () => {
  it('are the native-chat agents, which are Claude, Codex, Pi and every ACP chat agent', () => {
    expect([...NATIVE_CHAT_AGENTS].sort()).toEqual(
      ['claude', 'codex', 'pi', ...ACP_LAUNCH_SPECS.map((spec) => spec.agent)].sort()
    )
  })

  it('are every native-chat agent but the held-back ones', () => {
    expect([...BOT_AGENTS, ...BOT_HELD_BACK_AGENTS].sort()).toEqual([...NATIVE_CHAT_AGENTS].sort())
  })

  it('each have a way to take the bot’s preamble', () => {
    for (const spec of ACP_LAUNCH_SPECS) {
      if (BOT_AGENTS.some((agent) => agent === spec.agent)) {
        expect(spec.instructions, spec.agent).toBeDefined()
      }
    }
  })
})
