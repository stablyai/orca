// The Claude half of restart reconciliation: which transcript records become
// evidence, and when the read may be called boundary-consistent at all.

import { describe, expect, it } from 'vitest'
import { structuredAgentSessionSendBody } from '../../shared/structured-agent-session-outbox'
import { structuredAgentSessionPayloadFingerprint } from '../../shared/structured-agent-session-mutation'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { claudeProviderHistoryWindowFromJsonl } from './claude-structured-history-window'

const PROVIDER_SESSION = 'provider-1'
const ORCA_SESSION = 'session-1'

type Row = Record<string, unknown>

function prompt(uuid: string, parentUuid: string | null, content: unknown, extra: Row = {}): Row {
  return {
    type: 'user',
    uuid,
    parentUuid,
    sessionId: PROVIDER_SESSION,
    message: { role: 'user', content },
    ...extra
  }
}

function jsonl(rows: Row[], leafUuid: string): string {
  const lines = [...rows, { type: 'last-prompt', sessionId: PROVIDER_SESSION, leafUuid }]
  return `${lines.map((row) => JSON.stringify(row)).join('\n')}\n`
}

function read(contents: string, previousLeafUuid: string | null, turnInFlight = false) {
  return claudeProviderHistoryWindowFromJsonl({
    contents,
    providerSessionId: PROVIDER_SESSION,
    previousLeafUuid,
    sessionId: ORCA_SESSION,
    turnInFlight
  })
}

/** The digest the submission row carries for a plain typed send. */
function sendFingerprint(text: string): string {
  return structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: ORCA_SESSION,
    fields: { body: structuredAgentSessionSendBody(text, []) }
  })
}

const ANCHOR = prompt('anchor', null, 'earlier turn')

describe('claudeProviderHistoryWindowFromJsonl', () => {
  it('pins the renderer and host fingerprint functions to the same digest', () => {
    // The renderer computes a send's fingerprint with one, the host admission gate
    // validates it with the other, and the window matches with the host's. A
    // divergence would refuse every send long before it reached here — but it
    // would also silently turn every reconciliation into `not_delivered`.
    const input = {
      method: 'agentSession.send',
      sessionId: ORCA_SESSION,
      fields: { body: structuredAgentSessionSendBody('ship it', []) }
    }

    expect(structuredAgentSessionPayloadFingerprint(input)).toBe(
      computeAgentSessionPayloadFingerprint(input)
    )
  })

  it('fingerprints a prompt after the anchor exactly as the send that produced it', () => {
    const contents = jsonl(
      [ANCHOR, prompt('u-1', 'anchor', [{ type: 'text', text: 'ship it' }])],
      'u-1'
    )

    const window = read(contents, 'anchor')

    expect(window.boundaryConsistent).toBe(true)
    expect(window.items).toEqual([
      {
        providerItemId: 'u-1',
        clientMessageId: null,
        payloadFingerprint: sendFingerprint('ship it'),
        identity: { provider: 'claude', sessionId: PROVIDER_SESSION, uuid: 'u-1' }
      }
    ])
  })

  it('fingerprints a string-content prompt the same as a block-content one', () => {
    const asString = read(jsonl([ANCHOR, prompt('u-1', 'anchor', 'ship it')], 'u-1'), 'anchor')

    expect(asString.items[0]?.payloadFingerprint).toBe(sendFingerprint('ship it'))
  })

  it('excludes everything before the anchor', () => {
    const contents = jsonl(
      [
        prompt('root', null, 'first'),
        prompt('anchor', 'root', 'second'),
        prompt('u-1', 'anchor', 'third')
      ],
      'u-1'
    )

    expect(read(contents, 'anchor').items.map((item) => item.providerItemId)).toEqual(['u-1'])
  })

  it('reports no window and an inconsistent boundary without a durable anchor', () => {
    const contents = jsonl([ANCHOR, prompt('u-1', 'anchor', 'ship it')], 'u-1')

    expect(read(contents, null)).toEqual({
      items: [],
      boundaryConsistent: false,
      turnInFlight: false
    })
  })

  it('reports an inconsistent boundary when the anchor is gone from the file', () => {
    // What a compaction or a fresh session file leaves behind.
    const contents = jsonl([prompt('u-1', null, 'ship it')], 'u-1')

    expect(read(contents, 'anchor').boundaryConsistent).toBe(false)
  })

  it('reports an inconsistent boundary when the leaf is on a sibling branch', () => {
    const contents = jsonl(
      [
        prompt('root', null, 'first'),
        prompt('anchor', 'root', 'second'),
        prompt('u-1', 'root', 'branched')
      ],
      'u-1'
    )

    expect(read(contents, 'anchor').boundaryConsistent).toBe(false)
  })

  it('reports an inconsistent boundary on a torn tail', () => {
    const contents = `${jsonl([ANCHOR, prompt('u-1', 'anchor', 'ship it')], 'u-1')}{"type":"user"`

    expect(read(contents, 'anchor').boundaryConsistent).toBe(false)
  })

  it('keeps the boundary consistent and the window empty when nothing followed the anchor', () => {
    expect(read(jsonl([ANCHOR], 'anchor'), 'anchor')).toEqual({
      items: [],
      boundaryConsistent: true,
      turnInFlight: false
    })
  })

  it('excludes harness-injected turns, meta turns, tool results and sidechains', () => {
    const contents = jsonl(
      [
        ANCHOR,
        prompt('u-reminder', 'anchor', [
          { type: 'text', text: '<system-reminder>be careful</system-reminder>' }
        ]),
        prompt('u-meta', 'u-reminder', [{ type: 'text', text: 'injected' }], { isMeta: true }),
        prompt('u-tool', 'u-meta', [{ type: 'tool_result', content: 'ok' }]),
        prompt('u-real', 'u-tool', 'ship it')
      ],
      'u-real'
    )

    expect(read(contents, 'anchor').items.map((item) => item.providerItemId)).toEqual(['u-real'])
  })

  it('excludes a prompt carrying an image, whose path the transcript does not keep', () => {
    const contents = jsonl(
      [
        ANCHOR,
        prompt('u-img', 'anchor', [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
        ])
      ],
      'u-img'
    )

    expect(read(contents, 'anchor').items).toEqual([])
    expect(read(contents, 'anchor').boundaryConsistent).toBe(true)
  })

  it('carries the caller-proven turn-in-flight fact through to the window', () => {
    const contents = jsonl([ANCHOR, prompt('u-1', 'anchor', 'ship it')], 'u-1')

    expect(read(contents, 'anchor', true).turnInFlight).toBe(true)
  })
})
