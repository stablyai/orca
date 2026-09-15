import { describe, expect, it } from 'vitest'
import {
  isSubagentTranscriptFileName,
  partitionSubagentTranscriptPaths,
  subagentTranscriptsDirFor
} from './session-scanner-subagent-transcripts'

describe('ZeroClaw subagent and swarm transcript discovery', () => {
  it('recognizes agent-, subagent-, and swarm- transcript files (.jsonl and .json)', () => {
    expect(isSubagentTranscriptFileName('agent-task-1.jsonl', true)).toBe(true)
    expect(isSubagentTranscriptFileName('subagent-coder-2.jsonl', true)).toBe(true)
    expect(isSubagentTranscriptFileName('subagent-reviewer-3.json', true)).toBe(true)
    expect(isSubagentTranscriptFileName('swarm-worker-4.jsonl', true)).toBe(true)

    // Negative cases
    expect(isSubagentTranscriptFileName('agent-task-1.meta.json', true)).toBe(false)
    expect(isSubagentTranscriptFileName('subagent-dir', false)).toBe(false)
    expect(isSubagentTranscriptFileName('regular-session.jsonl', true)).toBe(false)
  })

  it('computes subagent directory for ZeroClaw session', () => {
    const parent = '/home/user/.zeroclaw/sessions/sess-123.jsonl'
    expect(subagentTranscriptsDirFor(parent)).toBe(
      '/home/user/.zeroclaw/sessions/sess-123/subagents'
    )
  })

  it('partitions ZeroClaw subagent transcripts from session candidates', () => {
    const paths = [
      '/home/user/.zeroclaw/sessions/sess-abc.jsonl',
      '/home/user/.zeroclaw/sessions/sess-abc/subagents/subagent-1.jsonl',
      '/home/user/.zeroclaw/sessions/sess-abc/subagents/subagent-2.json',
      '/home/user/.zeroclaw/sessions/sess-xyz.jsonl',
      '/home/user/.zeroclaw/sessions/sess-xyz/subagents/swarm-worker.jsonl'
    ]

    const result = partitionSubagentTranscriptPaths(paths)
    expect(result.sessionFilePaths).toEqual([
      '/home/user/.zeroclaw/sessions/sess-abc.jsonl',
      '/home/user/.zeroclaw/sessions/sess-xyz.jsonl'
    ])

    expect(
      result.subagentTranscriptCounts.get('/home/user/.zeroclaw/sessions/sess-abc.jsonl')
    ).toBe(2)
    expect(
      result.subagentTranscriptCounts.get('/home/user/.zeroclaw/sessions/sess-xyz.jsonl')
    ).toBe(1)
  })
})
