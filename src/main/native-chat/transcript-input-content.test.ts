import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { decodeCodexTranscriptLine } from './transcript-decoding/transcript-line-decoders-codex'
import { opencodeMessages } from './transcript-history/opencode/transcript-opencode-part-blocks'
import { decodeClaudeTranscriptLine } from './transcript-decoding/transcript-line-decoders-claude'
import { decodeOmpTranscriptLine } from './transcript-decoding/transcript-line-decoders-omp'
import { decodeGrokTranscriptLine } from './transcript-decoding/transcript-line-decoders-grok'
import { prepareNativeChatMessages } from '../../shared/native-chat/transcript/native-chat-message-preparation'
import {
  nativeChatSourceMessageKey,
  nativeChatSourcePendingKeys
} from '../../shared/native-chat/transcript/native-chat-input-content-key'
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

it('keeps exact Codex evidence distinct while allowing normalized main text to settle', () => {
  const payload = { message: 'literal [Image #1]\nkeep  spaceshere', local_images: [], images: [] }
  const entry = { ...pending, text: 'literal [Image #1]\nkeep  spaces\u0085here' }
  expect(reconcile(payload, entry)).toEqual([])
  expect(nativeChatSourcePendingKeys(entry)).toEqual([
    '["codex","46d3874abddd0edb743ee8ce66b04dcd7ff56d2a39b86f2b91117732b5811f6e",[]]'
  ])
  expect(
    nativeChatSourceMessageKey(
      read({ type: 'user_message', ...payload, local_images: ['/tmp/one.png'] })
    )
  ).toBe(
    '["codex","46d3874abddd0edb743ee8ce66b04dcd7ff56d2a39b86f2b91117732b5811f6e",["/tmp/one.png"]]'
  )
  expect(reconcile({ ...payload, local_images: ['/tmp/one.png'] }, entry)).toEqual([])
  const spaced = { ...payload, message: payload.message.replace('keep  spaces', 'keep spaces') }
  expect(nativeChatSourceMessageKey(read({ type: 'user_message', ...spaced }))).toBe(
    '["codex","79c33fbfce729c64f7e199c1174cd8f1fd99df3f796221777cd1578e40eb4f0d",[]]'
  )
  expect(
    reconcile(
      { ...payload, message: payload.message.replace('keep  spaces', 'keep spaces') },
      entry
    )
  ).toEqual([])
})

it('does not invent source evidence for file-backed attachments or literal markers', () => {
  const textOnly = { ...pending, imagePaths: [], text: 'literal [Image #1]' }
  expect(reconcile({ message: 'literal [Image #1]', local_images: [] }, textOnly)).toEqual([])
  expect(nativeChatSourcePendingKeys(textOnly)).toEqual([
    '["codex","8f1481ff383be647ce2e68924aa56c6d37f128d6af98563324a9d265bee49532",[]]'
  ])
  expect(
    nativeChatSourceMessageKey(read({ type: 'user_message', message: 'literal', local_images: [] }))
  ).toBe('["codex","829f8d848b44fa3098194754af5b60e2fb1517b0195956841beb6cac9bc68067",[]]')
  expect(reconcile({ message: 'literal', local_images: [] }, textOnly)).toEqual([])
  expect(
    read({
      type: 'user_message',
      message: 'literal [Image #1]',
      local_images: [],
      file_ids: ['image-file']
    }).inputContent
  ).toBeUndefined()
  expect(
    reconcile(
      { message: 'literal [Image #1]', local_images: [], file_ids: ['image-file'] },
      textOnly
    )
  ).toEqual([])
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
  expect(nativeChatSourcePendingKeys(entry)).toEqual([
    '["omp","199cf2ad43a1160a2fa05c229885b2847869eb2b63e9f871dd149e0d890f7ebb",[]]'
  ])
  expect(extraImage.inputContent).toBeUndefined()
  expect(
    prunePendingSends([entry], prepareNativeChatMessages([extraImage, answer], 'omp'))
  ).toEqual([])
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
  expect(rows.map((row) => row.inputContent)).toEqual([undefined, undefined])
  const twice = prepareNativeChatMessages(prepared, 'claude')
  expect(twice.filter((row) => row.role === 'user').map((row) => row.inputContent)).toEqual([
    undefined,
    undefined
  ])
  expect(prunePendingSends([entry], twice)).toEqual([])
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
  expect(nativeChatSourcePendingKeys(first)).toEqual([
    '["opencode","c4011b3d9d3b7c5e6b017ef0b4d4724010e7e7f4743bb9303ef8ab72ca56c53e",[]]'
  ])
  expect(nativeChatSourceMessageKey(decode('alpha\nbeta'))).toBe(
    '["opencode","bbfb79e82216bd2db1ad2c507d44ddf80aeb12f64f9562056afe93aad43154d9",[]]'
  )
  expect(prunePendingSends([first], [decode('alpha\nbeta'), answer])).toEqual([])
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

it('keeps OpenCode paste and short-input evidence exact alongside normalized main matching', () => {
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
  expect(nativeChatSourcePendingKeys(input)).toEqual([
    '["opencode","f3220283d05d1ff2ae350cfe9e0e367cb5aef46e10efb203c8a53c678e2218c8",[]]',
    '["opencode","9eec1a8a581114cbb62c6aa5e6887771e8d6ea3261d5fd6604f08e3cc25c6858",[]]'
  ])
  expect(nativeChatSourceMessageKey(decode('alpha beta gamma'))).toBe(
    '["opencode","64989ccbf3efa9c84e2afe7cee9bc5828bf0fcb91e44f8c1e591638a2c2e90e3",[]]'
  )
  expect(prunePendingSends([input], [decode('alpha beta gamma'), answer])).toEqual([])
  const short = { ...input, id: 'short', text: `  ${'x'.repeat(160)}  `, imagePaths: [] }
  expect(nativeChatSourcePendingKeys(short)).toEqual([
    '["opencode","0b845328e1730cfad1388fc8a9293afd163f832305e9d6e7bb5dd89453eab3c0",[]]'
  ])
  expect(nativeChatSourceMessageKey(decode('x'.repeat(160)))).toBe(
    '["opencode","60ba0840031727513556758984811b638f10d19eff569b7ceeab609c72dbe193",[]]'
  )
  expect(prunePendingSends([short], [decode('x'.repeat(160)), answer])).toEqual([])
  expect(prunePendingSends([short], [decode(`  ${'x'.repeat(160)}  `), answer])).toEqual([])
})
