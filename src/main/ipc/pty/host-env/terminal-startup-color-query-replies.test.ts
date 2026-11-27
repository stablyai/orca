import { expect, it } from 'vitest'
import { agentSkipsStartupOscColorQueryReplies } from './terminal-startup-color-query-replies'

it('suppresses startup OSC color replies for Antigravity', () => {
  expect(agentSkipsStartupOscColorQueryReplies({ launchAgent: 'antigravity' })).toBe(true)
  expect(agentSkipsStartupOscColorQueryReplies({ telemetry: { agent_kind: 'antigravity' } })).toBe(
    true
  )
  expect(agentSkipsStartupOscColorQueryReplies({ command: 'agy' })).toBe(true)
  expect(agentSkipsStartupOscColorQueryReplies({ launchAgent: 'codex' })).toBe(false)
})
