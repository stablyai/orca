import { expect, it } from 'vitest'
import { boundPayload } from '../agent-session-journal/journal-payload-bounds'
import { AgentSessionDeltaDigest } from './agent-session-delta-digest'

const HEAD = 16 * 1024

function digestOf(chunks: string[]): AgentSessionDeltaDigest {
  const digest = new AgentSessionDeltaDigest()
  for (const chunk of chunks) {
    digest.append(chunk)
  }
  return digest
}

it.each([
  {
    name: 'a surrogate pair split across chunks',
    chunks: ['a\ud83d', '\ude00b', 'c'.repeat(HEAD)]
  },
  { name: 'a lone trailing high surrogate', chunks: ['x'.repeat(HEAD), '\ud83d'] },
  { name: 'one multi-byte chunk crossing the head', chunks: ['é'.repeat(HEAD), 'tail'] },
  {
    name: 'a pair split exactly at the head',
    chunks: [`${'y'.repeat(HEAD - 2)}\ud83d`, '\ude00z']
  },
  { name: 'output under the head', chunks: ['small ', 'output'] }
])('matches the whole-output preview for $name', ({ chunks }) => {
  expect(digestOf(chunks).payload(chunks, HEAD)).toEqual(
    boundPayload(chunks.join(''), { inlineHeadBytes: HEAD })
  )
})

it('describes the retained text after the coalescer replaces its chunks', () => {
  const digest = digestOf(['dropped '.repeat(4096)])
  const retained = ['kept head\n[Orca: streamed output truncated]']
  digest.reset(retained)
  expect(digest.payload(retained, HEAD)).toEqual(
    boundPayload(retained.join(''), { inlineHeadBytes: HEAD })
  )
})
