import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { opencodeMessages } from './transcript-opencode-part-blocks'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { decodeOmpTranscriptLine } from './transcript-line-decoders-omp'
import { decodeGrokTranscriptLine } from './transcript-line-decoders-grok'
import { prepareNativeChatMessages } from '../../shared/native-chat/transcript/native-chat-message-preparation'
import {
  prunePendingSends,
  type NativeChatPendingSend
} from '../../shared/native-chat/transcript/native-chat-pending-sends'

const pending: NativeChatPendingSend = {
  id: 'send',
  sourceAgent: 'codex',
  text: '  literal [Image #1]\nkeep  spaces\u0085here  ',
  sentAt: 1
}

it.each([
  ['omp', 'omp-user-omp17.0.5-pr31973.jsonl', 'Reply with the word READY.'],
  [
    'omp',
    'omp-user-multiline-pr26494.jsonl',
    "Run this foreground command exactly as written using your terminal tool. Do not modify files.\n\nprintf 'ok\\n'"
  ],
  [
    'grok',
    'grok-user-grok1.0.70-pr38558.jsonl',
    'Read the file /Users/brennanbenson/orca-qa/pr38558-grok-g1/fixture/context2.txt and tell me both codenames it mentions.'
  ]
] as const)('reconciles genuine native %s user input from %s', (agent, file, text) => {
  const raw = readFileSync(new URL(`./__fixtures__/${file}`, import.meta.url), 'utf8')
  const decode = agent === 'omp' ? decodeOmpTranscriptLine : decodeGrokTranscriptLine
  const row = decode(raw, 'recorded')!
  const entry: NativeChatPendingSend = { id: 'send', sourceAgent: agent, text, sentAt: 1 }
  const answer = { ...row, id: 'answer', role: 'assistant' as const, inputContent: undefined }
  const messages = prepareNativeChatMessages([row, answer], agent)
  expect(prunePendingSends([entry], messages)).toEqual([])
  const different = { ...entry, text: `${text} extra` }
  expect(prunePendingSends([different], messages)).toEqual([different])
})

it('counts the recorded paginated user prompt once across its completed source rows', () => {
  const rows = readFileSync(
    new URL('../codex/__fixtures__/codex-rollout-b-0.162.1.jsonl', import.meta.url),
    'utf8'
  )
    .trim()
    .split('\n')
    .flatMap((line, index) => decodeCodexTranscriptLine(line, `recorded-${index}`) ?? [])
  const first: NativeChatPendingSend = {
    id: 'first',
    sourceAgent: 'codex',
    text: 'Reply only next-turn; leave both previous background processes alone.',
    sentAt: 1
  }
  const second = { ...first, id: 'second' }
  expect(
    prunePendingSends([first, second], prepareNativeChatMessages(rows, 'codex')).map(
      (entry) => entry.id
    )
  ).toEqual(['second'])
})

function read(payload: Record<string, unknown>) {
  return decodeCodexTranscriptLine(
    JSON.stringify({ type: 'event_msg', timestamp: '2026-11-09T17:00:00Z', payload }),
    'user'
  )!
}
function reconcile(payload: Record<string, unknown>, entry = pending) {
  const user = read({ type: 'user_message', ...payload })
  const answer = {
    id: 'answer',
    role: 'assistant' as const,
    blocks: [{ type: 'text' as const, text: 'done' }],
    timestamp: null,
    source: 'transcript' as const
  }
  return prunePendingSends([entry], prepareNativeChatMessages([user, answer], 'codex'))
}

it('settles exact submitted Codex text while retaining literal image markers and spacing', () => {
  const payload = { message: 'literal [Image #1]\nkeep  spaceshere', local_images: [], images: [] }
  const entry = { ...pending, text: 'literal [Image #1]\nkeep  spaces\u0085here' }
  expect(reconcile(payload, entry)).toEqual([])
  expect(reconcile({ ...payload, local_images: ['/tmp/one.png'] }, entry)).toEqual([entry])
  expect(
    reconcile(
      { ...payload, message: payload.message.replace('keep  spaces', 'keep spaces') },
      entry
    )
  ).toEqual([entry])
})

it('does not turn unaccounted file-backed attachments or literal-marker differences into text-only delivery', () => {
  const textOnly = { ...pending, imagePaths: [], text: 'literal [Image #1]' }
  expect(reconcile({ message: 'literal [Image #1]', local_images: [] }, textOnly)).toEqual([])
  expect(reconcile({ message: 'literal', local_images: [] }, textOnly)).toEqual([textOnly])
  expect(
    reconcile(
      { message: 'literal [Image #1]', local_images: [], file_ids: ['image-file'] },
      textOnly
    )
  ).toEqual([textOnly])
})

it('matches the complete submitted file-mention text without inventing attachment evidence from its expansion', () => {
  const entry: NativeChatPendingSend = {
    id: 'mention',
    sourceAgent: 'omp',
    sentAt: 1,
    text: '@"/tmp/one image.png"   caption\tline\nend'
  }
  const readOmp = (extra: unknown[] = []) =>
    decodeOmpTranscriptLine(
      JSON.stringify({
        type: 'message',
        id: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '@"/tmp/one image.png"   caption   line\nend' }, ...extra]
        }
      }),
      'user'
    )!
  const answer = { ...readOmp(), id: 'answer', role: 'assistant' as const, inputContent: undefined }
  expect(prunePendingSends([entry], prepareNativeChatMessages([readOmp(), answer], 'omp'))).toEqual(
    []
  )
  const extraImage = readOmp([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }])
  expect(
    prunePendingSends([entry], prepareNativeChatMessages([extraImage, answer], 'omp'))
  ).toEqual([entry])
})

it('keeps captured idle and human queued image inputs incomplete when Claude persisted no original paths', () => {
  const raw = readFileSync(
    new URL('./__fixtures__/claude-chat-image-input-2.1.308.jsonl', import.meta.url),
    'utf8'
  )
  const rows = raw
    .trim()
    .split('\n')
    .map((line, index) => decodeClaudeTranscriptLine(line, `captured-${index}`)!)
  expect(rows.map((row) => row.role)).toEqual(['user', 'user'])
  const entry: NativeChatPendingSend = {
    id: 'literal-caption',
    sourceAgent: 'claude',
    text: '[Image #7] [Image #8]  QA-BUSY-4 sent while working\nkeep   these   gaps and this literal [Image #1] marker\nName the main colour of each image attached to THIS message in order, quote line 2 exactly, then reply DONE-BUSY-4.',
    sentAt: 1
  }
  const answer = {
    id: 'answer',
    role: 'assistant' as const,
    blocks: [{ type: 'text' as const, text: 'done' }],
    timestamp: null,
    source: 'transcript' as const
  }
  const prepared = prepareNativeChatMessages([...rows, answer], 'claude')
  expect(prunePendingSends([entry], prepareNativeChatMessages(prepared, 'claude'))).toEqual([entry])
})

it('settles OpenCode multiline input and both real long-paste modes without reusing one source occurrence', () => {
  const decode = (text: string, id = 'user') =>
    opencodeMessages(
      { id, role: 'user', timestamp: null },
      [{ message_id: id, time_updated: 0, data: JSON.stringify({ type: 'text', text }) }],
      [],
      true
    )[0]
  const answer = {
    id: 'answer',
    role: 'assistant' as const,
    blocks: [{ type: 'text' as const, text: 'done' }],
    timestamp: null,
    source: 'transcript' as const
  }
  const first: NativeChatPendingSend = {
    id: 'first',
    sourceAgent: 'opencode',
    text: '  alpha\nbeta  ',
    sentAt: 1
  }
  expect(prunePendingSends([first], [decode('  alpha\nbeta  '), answer])).toEqual([])
  expect(prunePendingSends([first], [decode('alpha\nbeta'), answer])).toEqual([first])
  const long: NativeChatPendingSend = { ...first, text: '  alpha\nbeta\ngamma  ' }
  const second = { ...long, id: 'second', text: 'alpha\nbeta\ngamma' }
  expect(prunePendingSends([long], [decode('  alpha\nbeta\ngamma  '), answer])).toEqual([])
  expect(
    prunePendingSends([long, second], [decode('alpha\nbeta\ngamma'), answer]).map(
      (entry) => entry.id
    )
  ).toEqual(['second'])
  expect(
    prunePendingSends(
      [long, second],
      [decode('  alpha\nbeta\ngamma  '), decode('alpha\nbeta\ngamma', 'user2'), answer]
    )
  ).toEqual([])
})

it('does not allocate a recorded Codex response/completed pair to two sends', () => {
  const rows = readFileSync(
    new URL('./__fixtures__/codex-user-pair-0.162.1-pr36342.jsonl', import.meta.url),
    'utf8'
  )
    .trim()
    .split('\n')
    .flatMap((line, index) => decodeCodexTranscriptLine(line, `recorded-${index}`) ?? [])
  const first: NativeChatPendingSend = {
    id: 'first',
    sourceAgent: 'codex',
    text: 'Reply with the word BANANA and nothing else.',
    sentAt: 1
  }
  const second = { ...first, id: 'second' }
  const answer = {
    id: 'answer',
    role: 'assistant' as const,
    source: 'transcript' as const,
    timestamp: null,
    blocks: [{ type: 'text' as const, text: 'BANANA' }]
  }
  expect(
    prunePendingSends([first, second], prepareNativeChatMessages([...rows, answer], 'codex')).map(
      (entry) => entry.id
    )
  ).toEqual(['second'])
})

it('matches OpenCode text trimming and C1 paste sanitization without normalizing short typed input', () => {
  const decode = (text: string, id = 'user') =>
    opencodeMessages(
      { id, role: 'user', timestamp: null },
      [{ message_id: id, time_updated: 0, data: JSON.stringify({ type: 'text', text }) }],
      [],
      true
    )[0]
  const answer = {
    id: 'answer',
    role: 'assistant' as const,
    source: 'transcript' as const,
    timestamp: null,
    blocks: []
  }
  const input: NativeChatPendingSend = {
    id: 'text',
    sourceAgent: 'opencode',
    text: '  alpha\n\u009b31mbeta\ngamma  ',
    sentAt: 1
  }
  expect(prunePendingSends([input], [decode('alpha\nbeta\ngamma'), answer])).toEqual([])
  expect(prunePendingSends([input], [decode('  alpha\nbeta\ngamma  '), answer])).toEqual([])
  expect(prunePendingSends([input], [decode('alpha beta gamma'), answer])).toEqual([input])
  const short = { ...input, id: 'short', text: `  ${'x'.repeat(160)}  `, imagePaths: [] }
  expect(prunePendingSends([short], [decode('x'.repeat(160)), answer])).toEqual([short])
  expect(prunePendingSends([short], [decode(`  ${'x'.repeat(160)}  `), answer])).toEqual([])
})
