import { describe, expect, it } from 'vitest'

import {
  BRIDGE_PROTOCOL_VERSION,
  readBridgeClientMessage,
  readBridgeHostMessage
} from './bridge-envelope'

const ID = 'AAAAAAAAAAAAAAAAAAAAAA'

const SUCCESS_PAYLOAD = {
  id: 'r1',
  ok: true,
  result: { worktrees: [] },
  _meta: { runtimeId: 'runtime-a' }
}

function readClient(message: unknown): ReturnType<typeof readBridgeClientMessage> {
  return readBridgeClientMessage(JSON.stringify(message))
}

function readHost(message: unknown): ReturnType<typeof readBridgeHostMessage> {
  return readBridgeHostMessage(JSON.stringify(message))
}

function client(fields: Record<string, unknown>): Record<string, unknown> {
  return { v: BRIDGE_PROTOCOL_VERSION, ...fields }
}

describe('the readers bound their two directions differently', () => {
  const records = Array.from({ length: 5_000 }, (_, index) => ({
    id: index,
    name: `worktree-${index}`,
    branch: 'main',
    dirty: false
  }))

  it('accepts a reply carrying more values than the page-to-shell node cap', () => {
    const read = readHost({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id: ID,
      payload: { ...SUCCESS_PAYLOAD, result: records }
    })
    expect(
      read.ok && read.message.type === 'reply' && 'payload' in read.message && read.message.payload
    ).toEqual({
      ...SUCCESS_PAYLOAD,
      result: records
    })
  })

  it('refuses the page sending that many values back the other way', () => {
    expect(
      readClient(client({ type: 'request', id: ID, method: 'worktree.list', params: { records } }))
    ).toEqual({ ok: false, refusal: 'too-many-nodes' })
  })
})

// Pathnames and returned navigation hrefs share one segment rule; disagreement would expose a path through notify.
describe('navigate query boundaries', () => {
  it('refuses query-ended dot segments through the navigate reader', () => {
    for (const href of ['/h/..?x', '/h/%2e%2e?x', '/h/.?x', '/h/a/..?x', '/h/..?']) {
      expect(readClient(client({ type: 'notify', name: 'navigate', href })), href).toEqual({
        ok: false,
        refusal: 'unrecognised-message'
      })
    }
  })
})
