import { describe, expect, it } from 'vitest'
import {
  admitCandidates,
  COLLABORATION_MESSAGE_PRIORITIES,
  type AdmissionPolicy,
  type CollaborationCandidate
} from './collaboration-admission'
import type { MessagePriority } from '../orchestration/types'

const candidate = (
  id: string,
  type: string,
  priority: MessagePriority
): CollaborationCandidate => ({ id, message: { type, priority } })

describe('collaboration priority order', () => {
  it('exposes the same ascending order used by admission ranking', () => {
    expect(COLLABORATION_MESSAGE_PRIORITIES).toEqual(['normal', 'high', 'urgent'])
  })
})

describe('admitCandidates', () => {
  const policy: AdmissionPolicy = {
    acceptedTypes: ['status', 'dispatch', 'urgent_call'],
    minPriority: 'high'
  }

  it('admits accepted types at or above minPriority, sorted by priority descending with FIFO ties', () => {
    const input = [
      candidate('a', 'status', 'normal'),
      candidate('b', 'status', 'high'),
      candidate('c', 'urgent_call', 'urgent'),
      candidate('d', 'dispatch', 'high'),
      candidate('e', 'status', 'urgent')
    ]
    const { admitted } = admitCandidates(input, policy)
    expect(admitted.map((c) => c.id)).toEqual(['c', 'e', 'b', 'd'])
  })

  it('preserves original order for equal-priority admitted candidates', () => {
    const input = [
      candidate('a', 'status', 'urgent'),
      candidate('b', 'status', 'urgent'),
      candidate('c', 'status', 'urgent')
    ]
    const { admitted } = admitCandidates(input, policy)
    expect(admitted.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('returns filtered ids in input order and excludes admitted ids', () => {
    const input = [
      candidate('a', 'status', 'normal'),
      candidate('b', 'status', 'high'),
      candidate('c', 'unknown_type', 'urgent'),
      candidate('d', 'dispatch', 'normal')
    ]
    const { admitted, filtered } = admitCandidates(input, policy)
    expect(admitted.map((c) => c.id)).toEqual(['b'])
    expect(filtered).toEqual(['a', 'c', 'd'])
  })

  it('rejects messages below minPriority', () => {
    const input = [candidate('a', 'status', 'normal'), candidate('b', 'status', 'high')]
    const { admitted, filtered } = admitCandidates(input, policy)
    expect(admitted.map((c) => c.id)).toEqual(['b'])
    expect(filtered).toEqual(['a'])
  })

  it('rejects messages whose type is not accepted', () => {
    const input = [candidate('a', 'status', 'urgent'), candidate('b', 'banner', 'urgent')]
    const { admitted, filtered } = admitCandidates(input, policy)
    expect(admitted.map((c) => c.id)).toEqual(['a'])
    expect(filtered).toEqual(['b'])
  })

  it('closes admission when acceptedTypes is empty', () => {
    const input = [candidate('a', 'status', 'urgent'), candidate('b', 'dispatch', 'high')]
    const { admitted, filtered } = admitCandidates(input, {
      acceptedTypes: [],
      minPriority: 'normal'
    })
    expect(admitted).toEqual([])
    expect(filtered).toEqual(['a', 'b'])
  })

  it('does not mutate the input and returns new arrays', () => {
    const input = [candidate('a', 'status', 'urgent'), candidate('b', 'status', 'normal')]
    const snapshot = [...input]
    const result = admitCandidates(input, policy)
    expect(input).toEqual(snapshot)
    expect(result.admitted).not.toBe(input)
    expect(result.filtered).not.toBe(input)
  })

  it('handles an empty input', () => {
    const { admitted, filtered } = admitCandidates([], policy)
    expect(admitted).toEqual([])
    expect(filtered).toEqual([])
  })
})
