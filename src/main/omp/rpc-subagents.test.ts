import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { JsonlRpcPeer } from '../jsonl-rpc/peer'
import { OmpRpcSubagents } from './rpc-subagents'

it('retains child identity across malformed progress and publishes a later terminal exactly once', () => {
  const diagnostic = vi.fn()
  const children = new OmpRpcSubagents(diagnostic)
  const started = children.receive({
    type: 'subagent_lifecycle',
    payload: {
      id: 'child',
      agent: 'task',
      status: 'started',
      parentToolCallId: 'parent',
      description: 'Inspect code'
    }
  })
  expect(started).toMatchObject([
    { type: 'live', child: { handle: { id: 'child', runId: 'parent' } } }
  ])
  for (const payload of [
    undefined,
    {},
    { progress: null },
    { progress: { id: 'child', agent: 'task', status: 'future' } }
  ]) {
    expect(children.receive({ type: 'subagent_progress', payload })).toEqual([])
  }
  expect(diagnostic).toHaveBeenCalledTimes(4)
  const terminal = {
    type: 'subagent_lifecycle',
    payload: { id: 'child', agent: 'task', status: 'completed' }
  }
  expect(children.receive(terminal)).toMatchObject([
    { type: 'live', child: { name: 'Inspect code', handle: { id: 'child', runId: 'parent' } } },
    { type: 'ended', outcome: 'succeeded', handle: { id: 'child', runId: 'parent' } }
  ])
  expect(children.receive(terminal)).toEqual([])
})

it('keeps the peer alive for bad progress but explicitly fails for invalid lifecycle evidence', () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const diagnostic = vi.fn()
  const close = vi.fn()
  const ordinary = vi.fn()
  const children = new OmpRpcSubagents(diagnostic)
  const peer = new JsonlRpcPeer(input, output, {
    onRecord: (frame) => {
      if (children.receive(frame) === null) {
        ordinary(frame)
      }
    },
    onClose: close
  })
  const receive = (frame: unknown) => input.write(`${JSON.stringify(frame)}\n`)
  try {
    receive({ type: 'subagent_progress', payload: {} })
    receive({ type: 'agent_end', messages: [] })
    expect(diagnostic).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
    expect(ordinary).toHaveBeenCalledExactlyOnceWith({ type: 'agent_end', messages: [] })
    receive({
      type: 'subagent_lifecycle',
      payload: { id: 'child', agent: 'task', status: 'future' }
    })
    expect(close).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'OMP sent invalid subagent lifecycle data' })
    )
  } finally {
    peer.close()
    input.destroy()
    output.destroy()
  }
})
