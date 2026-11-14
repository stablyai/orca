import { expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { createAgentSessionCurrentRequestsReader } from '../../../../../shared/agent-session/requests/agent-session-current-requests-reader'
import type { AgentSessionCurrentRequestsMarker } from '../../../../../shared/agent-session/requests/agent-session-current-requests-wire'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from '../../../../../shared/agent-session/requests/agent-session-current-requests-capability'

import { readCurrentRequestsPiece } from '../agent-session-current-requests'

const marker: AgentSessionCurrentRequestsMarker = {
  contract: AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
  publisher: 'host',
  revision: 1,
  sessionId: 's',
  epoch: 'e',
  owner: 'host:fence-1',
  version: 'v1'
}
const prompt: AgentJournalRenderItem = {
  itemId: 'child',
  revision: 1,
  sequence: 1,
  observedAt: 10,
  body: {
    kind: 'approval',
    title: 'Inspect?',
    detail: '\\"😀'.repeat(800_000),
    options: [{ id: 'yes', label: 'Allow' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

it('pulls a greater-than-frame record and greater-than-window collection losslessly with one piece in flight', async () => {
  const items = [prompt]
  const projection = { identity: 'host', items, marker }
  let inFlight = 0
  let maximum = 0
  const complete = vi.fn()
  const error = vi.fn()
  const reader = createAgentSessionCurrentRequestsReader({
    read: async (request) => {
      maximum = Math.max(maximum, ++inFlight)
      await Promise.resolve()
      const piece = readCurrentRequestsPiece(projection, request)
      expect(Buffer.byteLength(JSON.stringify({ id: 'rpc', result: piece }))).toBeLessThan(
        200 * 1024
      )
      inFlight--
      return piece
    },
    complete,
    error,
    replaceMarker: vi.fn()
  })
  reader.observe(marker)
  await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(marker, items))
  expect(maximum).toBe(1)
  expect(error).not.toHaveBeenCalled()
  reader.invalidate()
})
