import { expect, it } from 'vitest'
import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../../../src/shared/native-chat/native-chat-types'
import { projectMobileNativeChatMessages } from './mobile-native-chat-projection'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
function row(
  id: string,
  role: NativeChatMessage['role'],
  blocks: NativeChatBlock[]
): NativeChatMessage {
  return { id, role, blocks, source: 'transcript', timestamp: 0 }
}
const prose = (id: string, text: string, role: NativeChatMessage['role'] = 'assistant') =>
  row(id, role, [{ type: 'text', text }])
const call = (id: string, state: 'running' | 'completed' = 'running'): NativeChatBlock => ({
  type: 'tool-call',
  callId: id,
  name: 'Read',
  input: { file_path: '/tmp/a.ts' },
  state
})
const result = (id: string): NativeChatBlock => ({
  type: 'tool-result',
  callId: id,
  output: 'contents'
})
const spawn = (id: string, state: 'working' | 'completed' = 'working') =>
  row(id, 'system', [{ type: 'subagent', id, groupId: 'live-group', label: id, state }])

it('skips blank assistant messages without hiding tools, images or later streamed words', () => {
  const commentary = prose('progress', 'Checking')
  const partial = { ...prose('partial', '\t'), shortened: true as const }
  const status = {
    ...prose('status', ' ', 'assistant'),
    blocks: [{ type: 'text' as const, text: ' ', presentation: 'turn-notice' }]
  }
  const read = call('read', 'completed')
  const image = row('image', 'assistant', [
    { type: 'text', text: ' ' },
    { type: 'image-ref', path: '/tmp/result.png' }
  ])
  const worker = { ...spawn('worker'), role: 'assistant' as const }
  const history = [
    commentary,
    prose('blank', ' '),
    row('empty', 'assistant', []),
    prose('empty-text', ''),
    row('tool', 'tool', [read, result('read')]),
    image,
    partial,
    status,
    worker
  ]
  const pending = prose('reply', '\n\t')
  const loaded = projectMobileNativeChatMessages([...history, pending], 'codex')
  expect(loaded.rows.map((message) => message.id)).toEqual([
    'progress',
    'image',
    'partial',
    'status',
    'worker'
  ])
  expect(loaded.rows[0]?.blocks).toEqual([
    { type: 'text', text: 'Checking' },
    read,
    { type: 'tool-result', callId: 'read', output: 'contents' }
  ])
  expect(loaded.rows[1]?.blocks).toContainEqual({ type: 'image-ref', path: '/tmp/result.png' })
  expect(loaded.rows.at(-1)?.blocks).toEqual([
    {
      type: 'subagent-group',
      groupId: 'live-group',
      agents: [{ id: 'worker', label: 'worker', state: 'working' }]
    }
  ])

  const live = projectMobileNativeChatMessages(
    [...history, prose('reply', 'Done')],
    'codex',
    loaded
  )
  expect(live.rows.map((message) => message.id)).toEqual([
    'progress',
    'image',
    'partial',
    'status',
    'worker',
    'reply'
  ])
  expect(live.rows.at(-1)?.blocks).toEqual([{ type: 'text', text: 'Done' }])
})

it('preserves source positions, tools and orphan ids across successive local replacements', () => {
  const lead = prose('a', 'Checking')
  const roster = spawn('s1')
  const tools = row('t', 'assistant', [call('read'), result('read'), result('missing')])
  tools.journalPosition = { sequence: 3, index: 0 }
  const collision = prose('unpaired-tool-results:["t",0]', 'reserved', 'user')
  let input = [lead, roster, tools, collision]
  let state = projectMobileNativeChatMessages(input, 'claude')
  expect(state.rows.map((message) => message.id)).toEqual([
    'a',
    's1',
    't',
    'unpaired-tool-results:["t",0]'
  ])
  const original = state.rows
  for (const blocks of [
    [
      { type: 'text' as const, text: 'Checking now' },
      { type: 'text' as const, text: '.' }
    ],
    [{ type: 'text' as const, text: 'Done' }]
  ]) {
    input = [{ ...lead, blocks }, roster, tools, collision]
    state = projectMobileNativeChatMessages(input, 'claude', state)
    expect(state.rows[0]!.blocks.slice(blocks.length)).toEqual([call('read'), result('read')])
    expect(state.rows[0]!.foldedJournalPosition).toEqual({ sequence: 3, index: 0 })
    expect(state.rows[2]!.blocks).toEqual([result('missing')])
  }
  expect(original[0]!.blocks[0]).toEqual({ type: 'text', text: 'Checking' })
  input = [
    input[0]!,
    spawn('s1', 'completed'),
    { ...tools, blocks: [call('read', 'completed'), result('read')] },
    collision
  ]
  state = projectMobileNativeChatMessages(input, 'claude', state)
  expect(state.rows.map((message) => message.id)).toEqual(['a', 's1', collision.id])
  // A real source occupying a generated orphan id forces only the affected namespace reconciliation.
  const orphan = row('orphan', 'assistant', [call('yes'), result('yes'), result('no')])
  let namespace = projectMobileNativeChatMessages([orphan], 'codex')
  expect(namespace.rows.map((message) => message.id)).toEqual([
    'orphan',
    'unpaired-tool-results:["orphan",0]'
  ])
  namespace = projectMobileNativeChatMessages(
    [orphan, prose('unpaired-tool-results:["orphan",0]', 'reserved', 'user')],
    'codex',
    namespace
  )
  expect(namespace.rows.map((message) => message.id)).toEqual([
    'orphan',
    'unpaired-tool-results:["orphan",1]',
    'unpaired-tool-results:["orphan",0]'
  ])
})

it('preserves image preparation through prompt edits and source resets', () => {
  const source = prose('image', '[Image: source: /tmp/a.png]', 'user')
  let state = projectMobileNativeChatMessages(
    [source, prose('prompt', '[Image #1] inspect', 'user')],
    'claude'
  )
  expect(state.rows.map((message) => message.id)).toEqual(['prompt'])
  expect(state.rows[0]?.blocks).toEqual([
    { type: 'image-ref', path: '/tmp/a.png' },
    { type: 'text', text: 'inspect' }
  ])
  state = projectMobileNativeChatMessages(
    [source, prose('prompt', '[Image #1] explain', 'user')],
    'claude',
    state
  )
  expect(state.rows[0]?.blocks).toEqual([
    { type: 'image-ref', path: '/tmp/a.png' },
    { type: 'text', text: 'explain' }
  ])
  const prompt = prose('prompt', '[Image #1] explain', 'user')
  state = projectMobileNativeChatMessages(
    [source, prose('separator', 'Answer'), prompt],
    'claude',
    state
  )
  expect(state.rows.map((message) => [message.id, message.blocks])).toEqual([
    ['image', [{ type: 'image-ref', path: '/tmp/a.png' }]],
    ['separator', [{ type: 'text', text: 'Answer' }]],
    ['prompt', [{ type: 'text', text: 'explain' }]]
  ])
  state = projectMobileNativeChatMessages([source, prompt], 'claude', state)
  expect(state.rows[0]?.blocks).toEqual([
    { type: 'image-ref', path: '/tmp/a.png' },
    { type: 'text', text: 'explain' }
  ])
  state = projectMobileNativeChatMessages([prompt], 'claude', state)
  expect(state.rows.map((message) => [message.id, message.blocks])).toEqual([
    ['prompt', [{ type: 'text', text: 'explain' }]]
  ])
  state = projectMobileNativeChatMessages([prose('other', 'Another chat')], 'codex', state)
  expect(state.rows.map((message) => message.id)).toEqual(['other'])
  expect(state.rows[0]?.blocks).toEqual([{ type: 'text', text: 'Another chat' }])
})

it('reveals a retained command reply when paging loads its parent', () => {
  const reply = {
    ...prose('output', '<local-command-stdout>context report</local-command-stdout>', 'user'),
    parentId: 'command'
  }
  let state = projectMobileNativeChatMessages([reply], 'openclaude')
  expect(state.rows).toEqual([])
  const parent = prose('command', '<command-name>/context</command-name>', 'user')
  state = projectMobileNativeChatMessages([parent, reply], 'openclaude', state)
  expect(state.rows.map((message) => message.id)).toEqual(['output'])
  expect(state.rows[0]).toMatchObject({
    role: 'system',
    blocks: [{ type: 'text', text: 'context report', presentation: 'command-output' }]
  })
  state = projectMobileNativeChatMessages([reply], 'openclaude', state)
  expect(state.rows).toEqual([])
  state = projectMobileNativeChatMessages([reply, parent], 'openclaude', state)
  expect(state.rows.map((message) => message.id)).toEqual(['output'])
  state = projectMobileNativeChatMessages(
    [reply, prose('command', '<command-name>/model</command-name>', 'user')],
    'openclaude',
    state
  )
  expect(state.rows.map((message) => [message.id, message.blocks])).toEqual([
    ['command', [{ type: 'text', text: '/model' }]]
  ])
})

it('forgets evicted tool contributions and releases generated orphan names', () => {
  const reserved = prose('unpaired-tool-results:["a",0]', 'Reserved', 'user')
  const a = row('a', 'assistant', [{ type: 'text', text: 'Checking' }, result('missing')])
  const boundary = prose('boundary', 'Next', 'user')
  const b = row('b', 'assistant', [call('read')])
  const t = row('t', 'tool', [result('read')])
  let state = projectMobileNativeChatMessages([reserved, a, boundary, b, t], 'claude')
  expect(state.rows.map((message) => message.id)).toEqual([
    reserved.id,
    'a',
    'unpaired-tool-results:["a",1]',
    'boundary',
    'b'
  ])
  state = projectMobileNativeChatMessages(
    [a, boundary, b, t, prose('tail', 'End', 'user')],
    'claude',
    state
  )
  expect(state.rows.map((message) => message.id)).toEqual([
    'a',
    'unpaired-tool-results:["a",0]',
    'boundary',
    'b',
    'tail'
  ])
  state = projectMobileNativeChatMessages(
    [t, prose('tail', 'End', 'user'), prose('new', 'New')],
    'claude',
    state
  )
  expect(state.rows.map((message) => [message.id, message.blocks])).toEqual([
    ['t', [result('read')]],
    ['tail', [{ type: 'text', text: 'End' }]],
    ['new', [{ type: 'text', text: 'New' }]]
  ])
  const sidecar = row('sidecar', 'user', [
    result('unknown'),
    { type: 'text', text: '<system-reminder>Reminder</system-reminder>' }
  ])
  const lead = prose('lead', 'First')
  state = projectMobileNativeChatMessages([lead, sidecar], 'claude')
  state = projectMobileNativeChatMessages(
    [
      prose('lead', 'Second'),
      sidecar,
      prose('unpaired-tool-results:["sidecar",0]', 'Reserved', 'user')
    ],
    'claude',
    state
  )
  expect(state.rows.map((message) => message.id)).toEqual([
    'lead',
    'unpaired-tool-results:["sidecar",1]',
    'unpaired-tool-results:["sidecar",0]'
  ])
  expect(state.rows[1]?.blocks).toEqual([result('unknown')])
})
