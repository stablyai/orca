import { expect, it } from 'vitest'
import { structuredAgentLaunchEnv } from './structured-agent-launch-env'

it('starts Claude chats without the fallback switch when Stop is chosen', () => {
  const settings = { claudeFlaggedRequestAction: 'stop' as const }
  expect(structuredAgentLaunchEnv('claude', settings, {}, 'darwin')).toEqual({
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1'
  })
  expect(structuredAgentLaunchEnv('codex', settings, {}, 'darwin')).toEqual({})
})
