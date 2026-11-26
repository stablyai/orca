import { expect, it } from 'vitest'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

// OpenCode's ACP answers session/prompt at once for a command its catalog
// knows — the command steers into the session and reports success without
// awaiting the turn (opencode 2.x, #49056). The work that streams on after
// the answer is unprompted: it gets a turn of its own, which quiet, Stop
// or the next send ends, so the pane shows it live instead of settling the
// send at "Worked for 0s" with nothing under it.
it('gives the work of an early-answered command a turn of its own', () => {
  const lane = new AcpTimelineTranslator({ sessionId: 's', dialect: OPENCODE_ACP_DIALECT })
  lane.openPrompt('p', 1)
  const settled = lane.promptResult('p', { stopReason: 'end_turn' }, 2)
  expect(settled.some((event) => event.type === 'turn.end' && event.outcome === 'success')).toBe(
    true
  )
  const events = lane.notification(
    'session/update',
    {
      sessionId: 's',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Read issue 615',
        kind: 'read',
        status: 'in_progress'
      }
    },
    3
  )
  const opened = events.find((event) => event.type === 'turn.open')
  const agentTurn = opened?.type === 'turn.open' ? opened.turn : undefined
  expect(agentTurn).toMatch(/^agent:/)
  const item = events.find((event) => event.type === 'item.open')
  expect(item?.type === 'item.open' ? item.join?.turn : undefined).toBe(agentTurn)
  // The call finishes, and quiet ends the turn, as the lane's timer asks.
  lane.notification(
    'session/update',
    {
      sessionId: 's',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' }
    },
    4
  )
  const ended = lane.endAgentTurn(5)
  expect(ended).toEqual([
    expect.objectContaining({ type: 'turn.end', turn: agentTurn, outcome: 'success' })
  ])
})
