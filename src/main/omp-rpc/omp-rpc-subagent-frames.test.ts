import { describe, expect, it } from 'vitest'
import {
  parseOmpRpcSubagentEventFrame,
  parseOmpRpcSubagentLifecycleFrame,
  parseOmpRpcSubagentProgressFrame
} from './omp-rpc-subagent-frames'

const LIFECYCLE = {
  type: 'subagent_lifecycle',
  payload: {
    id: 'sa-1',
    index: 0,
    agent: 'explorer',
    agentSource: 'builtin',
    status: 'started',
    sessionFile: '/tmp/sa-1.jsonl',
    detached: true
  }
}

const PROGRESS = {
  type: 'subagent_progress',
  payload: {
    index: 0,
    agent: 'explorer',
    agentSource: 'builtin',
    task: 'map the auth flow',
    progress: {
      id: 'sa-1',
      index: 0,
      agent: 'explorer',
      status: 'running',
      task: 'map the auth flow',
      recentTools: [],
      recentOutput: [],
      toolCount: 2,
      requests: 1,
      tokens: 900,
      cost: 0.01,
      durationMs: 1200
    }
  }
}

describe('parseOmpRpcSubagentLifecycleFrame', () => {
  it('accepts the canonical payload and passes unread fields through', () => {
    const frame = parseOmpRpcSubagentLifecycleFrame(LIFECYCLE)
    expect(frame?.payload.id).toBe('sa-1')
    expect(frame?.payload.sessionFile).toBe('/tmp/sa-1.jsonl')
    expect(frame?.payload.detached).toBe(true)
  })

  it.each([
    ['a missing id', { ...LIFECYCLE.payload, id: undefined }],
    ['a missing index', { ...LIFECYCLE.payload, index: undefined }],
    ['a non-integer index', { ...LIFECYCLE.payload, index: 1.5 }],
    ['a missing agent', { ...LIFECYCLE.payload, agent: undefined }],
    ['an unknown status', { ...LIFECYCLE.payload, status: 'sleeping' }]
  ])('rejects %s', (_label, payload) => {
    expect(parseOmpRpcSubagentLifecycleFrame({ ...LIFECYCLE, payload })).toBeNull()
  })

  it('rejects a frame with no payload at all', () => {
    expect(parseOmpRpcSubagentLifecycleFrame({ type: 'subagent_lifecycle' })).toBeNull()
  })

  it.each(['completed', 'failed', 'aborted'])('accepts the terminal status %s', (status) => {
    expect(
      parseOmpRpcSubagentLifecycleFrame({ ...LIFECYCLE, payload: { ...LIFECYCLE.payload, status } })
    ).not.toBeNull()
  })
})

describe('parseOmpRpcSubagentProgressFrame', () => {
  it('accepts the canonical payload', () => {
    const frame = parseOmpRpcSubagentProgressFrame(PROGRESS)
    expect(frame?.payload.progress.id).toBe('sa-1')
    expect(frame?.payload.progress.toolCount).toBe(2)
  })

  it('rejects a progress block with no id to key the roster on', () => {
    const payload = { ...PROGRESS.payload, progress: { ...PROGRESS.payload.progress, id: 7 } }
    expect(parseOmpRpcSubagentProgressFrame({ ...PROGRESS, payload })).toBeNull()
  })

  // AgentProgress admits `pending`, which the lifecycle union never reports.
  it('accepts the pending status the lifecycle union does not carry', () => {
    const payload = {
      ...PROGRESS.payload,
      progress: { ...PROGRESS.payload.progress, status: 'pending' }
    }
    expect(parseOmpRpcSubagentProgressFrame({ ...PROGRESS, payload })).not.toBeNull()
  })

  it('rejects a payload with no task', () => {
    const { task: _task, ...payload } = PROGRESS.payload
    expect(parseOmpRpcSubagentProgressFrame({ ...PROGRESS, payload })).toBeNull()
  })
})

describe('parseOmpRpcSubagentEventFrame', () => {
  it('accepts an attributed event and leaves the inner event untyped', () => {
    const frame = parseOmpRpcSubagentEventFrame({
      type: 'subagent_event',
      payload: { id: 'sa-1', event: { type: 'message_update', assistantMessageEvent: {} } }
    })
    expect(frame?.payload.id).toBe('sa-1')
    expect(frame?.payload.event.type).toBe('message_update')
  })

  it('rejects an event with no subagent attribution', () => {
    expect(
      parseOmpRpcSubagentEventFrame({ type: 'subagent_event', payload: { event: { type: 'x' } } })
    ).toBeNull()
  })

  it('rejects an inner event with no type tag', () => {
    expect(
      parseOmpRpcSubagentEventFrame({ type: 'subagent_event', payload: { id: 'sa-1', event: {} } })
    ).toBeNull()
  })
})
