import { describe, expect, it } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  SESSION_TABS_DELTA_OUT_OF_SYNC_ERROR,
  decodeSessionTabsDeltaEvents
} from './runtime-environment-session-tabs-delta-decoding'

function response(result: unknown): { type: 'response'; response: RuntimeRpcResponse<unknown> } {
  return {
    type: 'response',
    response: { id: 'req-1', ok: true, result, _meta: { runtimeId: 'r' } }
  }
}

const tab = (id: string, title: string) => ({ type: 'terminal', id, title })

describe('decodeSessionTabsDeltaEvents', () => {
  it('hands the window the full tab list a legacy host would send', () => {
    const seen: unknown[] = []
    const onEvent = decodeSessionTabsDeltaEvents('session.tabs.subscribe', (event) =>
      seen.push(event)
    )
    onEvent(
      response({
        type: 'snapshot',
        worktree: 'wt-1',
        snapshotVersion: 1,
        tabs: [tab('a', 'A'), tab('b', 'B')],
        tabsRevision: 1
      })
    )
    onEvent(
      response({
        type: 'updated',
        worktree: 'wt-1',
        snapshotVersion: 2,
        tabsRevision: 2,
        tabsDelta: { baseRevision: 1, tabs: [0, tab('b', 'B2')] }
      })
    )
    expect(seen).toEqual([
      response({
        type: 'snapshot',
        worktree: 'wt-1',
        snapshotVersion: 1,
        tabs: [tab('a', 'A'), tab('b', 'B')]
      }),
      response({
        type: 'updated',
        worktree: 'wt-1',
        snapshotVersion: 2,
        tabs: [tab('a', 'A'), tab('b', 'B2')]
      })
    ])
  })

  it('ends the stream with an error when a delta has no base, so the window resubscribes', () => {
    const seen: { type: string; response?: RuntimeRpcResponse<unknown> }[] = []
    const onEvent = decodeSessionTabsDeltaEvents('session.tabs.subscribeAll', (event) =>
      seen.push(event)
    )
    onEvent(
      response({
        type: 'updated',
        worktree: 'wt-1',
        tabsRevision: 3,
        tabsDelta: { baseRevision: 2, tabs: [0] }
      })
    )
    expect(seen[0]?.response).toMatchObject({
      ok: false,
      error: { code: SESSION_TABS_DELTA_OUT_OF_SYNC_ERROR }
    })
  })

  it('leaves other streams and non-response events alone', () => {
    const seen: unknown[] = []
    const onEvent = decodeSessionTabsDeltaEvents('files.watch', (event) => seen.push(event))
    const frame = response({ type: 'updated', tabsDelta: { baseRevision: 9, tabs: [0] } })
    onEvent(frame)
    expect(seen[0]).toBe(frame)
  })
})
