import { asRecord } from '../../../ai-vault/session-scanner-record-value'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  importLegacyTranscriptIntoJournal,
  prepareLegacyTranscriptImport
} from './journal-legacy-import'
import { finishTranscriptWork } from '../../transcript-work-scheduler'
import { legacyImportReplacementItemWork } from './journal-legacy-import-item'
import { createNewestItemWindow } from './journal-newest-item-window'
import { PI_CONTEXT_FIXTURES } from './journal-pi-context-fixtures'
import * as payloadBounds from '../item-lifecycle/journal-payload-bounds'
import { createTrackedJournalOpener } from '../store-lifecycle/journal-host-database-test-support'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

let root: string
const journals = createTrackedJournalOpener()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-import-incremental-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})
const pad = (line: string) => `${line.slice(0, -1)},"ignored":"${'x'.repeat(65536)}"}`
const text = (value: string, role = 'assistant') => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text: value }]
})

it.each(['claude', 'codex', 'grok', 'omp', 'pi'] as const)(
  'keeps existing %s presentation, identities and source checks across parser paths',
  async (agent) => {
    const filePath = join(root, 'session.jsonl')
    const header = JSON.stringify({ type: 'session', id: 'session', version: 3, cwd: root })
    const cases = {
      claude: {
        lines: [
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            interruptedMessageId: 'prior',
            message: { content: 'ordinary text' },
            sessionId: 'session',
            cwd: root
          })
        ],
        bodies: [
          { kind: 'message', role: 'system', blocks: [{ type: 'text', text: expect.any(String) }] }
        ],
        identities: [{ provider: 'claude', sessionId: 'session', uuid: 'u1' }]
      },
      codex: {
        lines: [
          JSON.stringify({ type: 'session_meta', payload: { id: 'session' } }),
          JSON.stringify({
            type: 'function_call',
            id: 'call',
            name: 'test',
            call_id: 'c1',
            arguments: '{}'
          }),
          JSON.stringify({
            type: 'local_shell_call',
            id: 'shell',
            name: 'shell',
            call_id: 'c2',
            action: { command: 'echo kept' }
          })
        ],
        bodies: [
          { kind: 'tool-call', name: 'test', input: '{}', callId: 'c1', state: 'completed' },
          {
            kind: 'tool-call',
            name: 'shell',
            input: { command: 'echo kept' },
            callId: 'c2',
            state: 'completed'
          }
        ],
        identities: [
          { provider: 'legacy', agent: 'codex', sessionId: 'session', recordId: 'call' },
          { provider: 'legacy', agent: 'codex', sessionId: 'session', recordId: 'shell' }
        ]
      },
      grok: {
        lines: [
          JSON.stringify({
            type: 'assistant',
            content: '',
            tool_calls: [{ id: 'c1', name: 'grep', arguments: '{"pattern":"foo"}' }],
            id: 'asst-1'
          })
        ],
        bodies: [
          { kind: 'tool-call', name: 'grep', input: { pattern: 'foo' }, state: 'completed' }
        ],
        identities: [
          { provider: 'legacy', agent: 'grok', sessionId: 'session', recordId: 'asst-1' }
        ]
      },
      omp: {
        lines: [
          header,
          JSON.stringify({
            type: 'message',
            id: 'rec-1',
            parentId: 'rec-0',
            message: { role: 'user', content: [{ type: 'text', text: 'resume' }] }
          })
        ],
        bodies: [text('resume', 'user')],
        identities: [{ provider: 'legacy', agent: 'omp', sessionId: 'session', recordId: 'rec-1' }]
      },
      pi: {
        lines: [header, ...PI_CONTEXT_FIXTURES[0].entries.map((entry) => JSON.stringify(entry))],
        bodies: [text('summary', 'system'), text('kept', 'user'), text('later', 'assistant')],
        identities: ['summary', 'kept', 'later'].map((recordId) => ({
          provider: 'legacy',
          agent: 'pi',
          sessionId: 'session',
          recordId
        }))
      }
    }
    const sample = cases[agent]
    for (const large of [false, true]) {
      await writeFile(filePath, sample.lines.map((line) => (large ? pad(line) : line)).join('\n'))
      const result = await prepareLegacyTranscriptImport({
        agent,
        sessionId: 'session',
        options: {
          filePath,
          ...(agent === 'grok'
            ? {}
            : { source: { providerSessionId: 'session', workspaceCwd: root } })
        }
      })
      if (!result.ok) {
        throw new Error(result.error)
      }
      expect(result.items.map((item) => item.body)).toEqual(sample.bodies)
      expect(result.items.map((item) => item.identity)).toEqual(sample.identities)
      expect(result.items.every((item) => Object.hasOwn(item, 'observedAt'))).toBe(true)
    }
  }
)

it('preserves non-finite values, signed zero and own data keys without a JSON round trip', async () => {
  const filePath = join(root, 'claude.jsonl')
  const line =
    '{"type":"assistant","uuid":"u","message":{"content":[{"type":"tool_use","name":"test","input":{"rows":[1e400,-0],"__proto__":{"kept":true}}}]}}'
  for (const large of [false, true]) {
    await writeFile(filePath, large ? pad(line) : line)
    const result = await prepareLegacyTranscriptImport({
      agent: 'claude',
      sessionId: 'session',
      options: { filePath }
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    const item = result.items[0]
    if (item.body.kind !== 'tool-call') {
      throw new Error('Expected tool input')
    }
    const input = asRecord(item.body.input)
    if (!input || !Array.isArray(input.rows)) {
      throw new Error('Expected object tool input')
    }
    expect(input.rows[0]).toBe(Infinity)
    expect(Object.is(input.rows[1], -0)).toBe(true)
    expect(Object.hasOwn(input, '__proto__')).toBe(true)
    expect(input.__proto__).toEqual({ kept: true })
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype)
    expect(Object.hasOwn(item, 'observedAt')).toBe(true)
    expect(item.observedAt).toBeUndefined()
  }
})

it('preserves surrogate code units and a key split across large parser inputs', async () => {
  const filePath = join(root, 'claude.jsonl')
  const prefix = '{"type":"assistant","uuid":"unicode","ignored":"'
  const middle = '","message":{"content":[{"type":"tool_use","name":"test","input":{"'
  const line = `${prefix}${'x'.repeat(131071 - prefix.length - middle.length)}${middle}😀key":"pair😀 high-\\ud800 low-\\udc00"}}]},"ignoredTail":"${'z'.repeat(65536)}"}`
  await writeFile(filePath, line)
  const result = await prepareLegacyTranscriptImport({
    agent: 'claude',
    sessionId: 'session',
    options: { filePath }
  })
  expect(result).toMatchObject({
    ok: true,
    items: [
      {
        body: {
          kind: 'tool-call',
          name: 'test',
          input: { '😀key': 'pair😀 high-\uD800 low-\uDC00' }
        }
      }
    ]
  })
})

it('finishes duplicate fields and metadata before observing or decoding a large record', async () => {
  const filePath = join(root, 'claude.jsonl')
  const line = `{"type":"assistant","uuid":"u","sessionId":"wrong","message":{"content":"discarded"},"message":{"content":"kept"},"sessionId":"session","cwd":${JSON.stringify(
    root
  )}}`
  await writeFile(filePath, pad(line))
  const result = await prepareLegacyTranscriptImport({
    agent: 'claude',
    sessionId: 'session',
    options: { filePath, source: { providerSessionId: 'session', workspaceCwd: root } }
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  expect(result.items[0].body).toEqual(text('kept'))
  await writeFile(filePath, `${pad(line)} trailing garbage`)
  const malformed = await prepareLegacyTranscriptImport({
    agent: 'claude',
    sessionId: 'session',
    options: { filePath }
  })
  expect(malformed).toEqual({ ok: true, items: [], sourceEmpty: false, forkTipItemIds: [] })
})

it.each(['object', 'array'] as const)(
  'retains full large Grok argument %s values',
  async (shape) => {
    const filePath = join(root, 'grok.jsonl')
    const padding = 'x'.repeat(65536)
    const argument =
      shape === 'object'
        ? JSON.stringify({
            path: '/x',
            unmodeled: { keep: true },
            message: { content: [{ source: { data: 'argument-data' } }] },
            padding
          })
        : `[1e400,-0,${JSON.stringify(padding)}]`
    await writeFile(
      filePath,
      JSON.stringify({
        type: 'assistant',
        id: 'r',
        content: '',
        tool_calls: [{ name: 'test', arguments: argument }]
      })
    )
    const result = await prepareLegacyTranscriptImport({
      agent: 'grok',
      sessionId: 'session',
      options: { filePath, limits: { inlineHeadBytes: 1024 * 1024 } }
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    const body = result.items[0].body
    if (body.kind !== 'tool-call') {
      throw new Error('Expected tool input')
    }
    if (shape === 'object') {
      expect(body.input).toEqual({
        path: '/x',
        unmodeled: { keep: true },
        message: { content: [{ source: { data: 'argument-data' } }] },
        padding
      })
    } else {
      if (!Array.isArray(body.input)) {
        throw new Error('Expected array tool input')
      }
      const input = body.input
      expect(input[0]).toBe(Infinity)
      expect(Object.is(input[1], -0)).toBe(true)
      expect(input[2]).toBe(padding)
    }
  }
)

it('preserves duplicate fields, image references and opaque tool values in large records', async () => {
  const filePath = join(root, 'claude.jsonl')
  await writeFile(
    filePath,
    [
      pad('{"type":"assistant","uuid":"discarded","message":{"content":"old"},"message":null}'),
      pad(
        '{"type":"assistant","uuid":"kept","message":null,"message":{"content":"kept"},"ignored":{"message":{"content":"wrong"},"empty":[{},[]]}}'
      ),
      `{"type":"user","uuid":"images","message":{"content":[{"source":{"url":"wrong"},"source":{"data":"discarded","data":{"nested":["${'A'.repeat(131072)}",{"message":{"content":[{"source":{"data":0}}]}}]},"url":"https://image"},"type":"text","type":"image","path":"/image","alt":"direct"},{"type":"image","source":{"data":[]},"path":"/path-only"},{"type":"image","source":{"data":"base64-only"}},{"type":"text","text":"after-image"}]}}`,
      pad(
        '{"type":"assistant","uuid":"tool","message":{"content":[{"type":"tool_use","name":"inspect","input":{"message":{"content":[{"source":{"data":"tool-data"}}]},"attachment":{"prompt":[{"source":{"data":"prompt-data"}}]},"__proto__":{"data":"own-data"}}}]}}'
      ),
      pad(
        '{"type":"user","uuid":"result","message":{"content":[{"type":"tool_result","tool_use_id":"call","content":{"source":{"data":"result-data"}}}]}}'
      ),
      pad(
        '{"type":"attachment","uuid":"queued","attachment":{"type":"queued_command","commandMode":"prompt","prompt":[{"source":{"data":null,"url":"https://queued"},"type":"image"},{"type":"text","text":"after-queued"}]}}'
      ),
      pad(
        '{"type":"user","uuid":"malformed","message":{"content":[{"type":"image","source":{"data":[1,],"url":"https://invalid"}}]}}'
      ),
      pad('{"type":"assistant","uuid":"following","message":{"content":"after-malformed"}}')
    ].join('\n')
  )
  const result = await prepareLegacyTranscriptImport({
    agent: 'claude',
    sessionId: 'session',
    options: { filePath }
  })
  expect(result).toMatchObject({
    ok: true,
    items: [
      { identity: { provider: 'claude', uuid: 'kept' }, body: text('kept') },
      {
        identity: { provider: 'claude', uuid: 'images' },
        body: {
          kind: 'message',
          role: 'user',
          blocks: [
            { type: 'image-ref', url: 'https://image', path: '/image', alt: 'direct' },
            { type: 'image-ref', path: '/path-only' },
            { type: 'text', text: 'after-image' }
          ]
        }
      },
      {
        identity: { provider: 'claude', uuid: 'tool' },
        body: {
          kind: 'tool-call',
          name: 'inspect',
          input: {
            message: { content: [{ source: { data: 'tool-data' } }] },
            attachment: { prompt: [{ source: { data: 'prompt-data' } }] },
            ['__proto__']: { data: 'own-data' }
          },
          state: 'completed'
        }
      },
      {
        identity: { provider: 'claude', uuid: 'result' },
        body: {
          kind: 'message',
          role: 'tool',
          blocks: [
            {
              type: 'tool-result',
              callId: 'call',
              output: '{"source":{"data":"result-data"}}'
            }
          ]
        }
      },
      {
        identity: { provider: 'claude', uuid: 'queued' },
        body: {
          kind: 'message',
          role: 'user',
          blocks: [
            { type: 'image-ref', url: 'https://queued' },
            { type: 'text', text: 'after-queued' }
          ]
        }
      },
      { identity: { provider: 'claude', uuid: 'following' }, body: text('after-malformed') }
    ]
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  expect(result.items.map((item) => item.identity)).toEqual([
    { provider: 'claude', sessionId: 'session', uuid: 'kept' },
    { provider: 'claude', sessionId: 'session', uuid: 'images' },
    { provider: 'claude', sessionId: 'session', uuid: 'tool' },
    { provider: 'claude', sessionId: 'session', uuid: 'result' },
    { provider: 'claude', sessionId: 'session', uuid: 'queued' },
    { provider: 'claude', sessionId: 'session', uuid: 'following' }
  ])
  await writeFile(
    filePath,
    pad('{"type":"assistant","uuid":"u","message":{"content":"hidden"},"ignored":{"bad":[1,]}}')
  )
  expect(
    await prepareLegacyTranscriptImport({
      agent: 'claude',
      sessionId: 'session',
      options: { filePath }
    })
  ).toEqual({ ok: true, items: [], sourceEmpty: false, forkTipItemIds: [] })
})

it.each(['[{"type":"assistant","message":{"content":"nested"}}]', 'null'])(
  'does not expose a nonobject transcript root %s',
  async (line) => {
    const filePath = join(root, 'claude.jsonl')
    await writeFile(filePath, line + ' '.repeat(65536))
    expect(
      await prepareLegacyTranscriptImport({
        agent: 'claude',
        sessionId: 'session',
        options: { filePath }
      })
    ).toEqual({ ok: true, items: [], sourceEmpty: false, forkTipItemIds: [] })
  }
)

it.each(['null', '{'])(
  'preserves Grok full-value or malformed arguments ending in %s',
  async (token) => {
    const filePath = join(root, 'grok.jsonl')
    const argument = ' '.repeat(65536) + token
    await writeFile(
      filePath,
      JSON.stringify({
        type: 'assistant',
        id: 'r',
        content: '',
        tool_calls: [{ name: 'test', arguments: argument }]
      })
    )
    const result = await prepareLegacyTranscriptImport({
      agent: 'grok',
      sessionId: 'session',
      options: { filePath, limits: { inlineHeadBytes: 1024 * 1024 } }
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.items.map((item) => item.body)).toEqual([
      {
        kind: 'tool-call',
        name: 'test',
        input: token === 'null' ? null : argument,
        state: 'completed'
      }
    ])
  }
)

it('accounts for exact native item bytes while retaining newest whole items', () => {
  const identity = {
    provider: 'legacy' as const,
    agent: 'claude' as const,
    sessionId: 'session',
    recordId: 'row'
  }
  const bounded = finishTranscriptWork(
    legacyImportReplacementItemWork(
      {
        id: 'row',
        role: 'assistant',
        timestamp: null,
        source: 'transcript',
        blocks: [
          { type: 'text', text: 'quote"\\\n😀\uD800' },
          { type: 'tool-call', name: 'test', input: { number: Infinity, zero: -0 } }
        ]
      },
      identity,
      { inlineHeadBytes: 16384 }
    )
  )
  const window = createNewestItemWindow(552)
  finishTranscriptWork(window.pushWork(bounded.item, bounded.bytes))
  const latest = { ...bounded.item, identity: { ...identity, recordId: 'new' } }
  finishTranscriptWork(window.pushWork(latest, bounded.bytes))
  expect(window.items().map((item) => item.identity)).toEqual([
    { provider: 'legacy', agent: 'claude', sessionId: 'session', recordId: 'row' },
    { provider: 'legacy', agent: 'claude', sessionId: 'session', recordId: 'new' }
  ])
  const tight = createNewestItemWindow(551)
  finishTranscriptWork(tight.pushWork(bounded.item, bounded.bytes))
  finishTranscriptWork(tight.pushWork(latest, bounded.bytes))
  expect(tight.items().map((item) => item.identity)).toEqual([
    { provider: 'legacy', agent: 'claude', sessionId: 'session', recordId: 'new' }
  ])
  const tiny = createNewestItemWindow(1)
  finishTranscriptWork(tiny.pushWork(latest, bounded.bytes))
  expect(tiny.items().map((item) => item.identity)).toEqual([
    { provider: 'legacy', agent: 'claude', sessionId: 'session', recordId: 'new' }
  ])
})

it('observes cancellation in a real turn during one item construction and returns no partial history', async () => {
  const filePath = join(root, 'claude.jsonl')
  await writeFile(
    filePath,
    JSON.stringify({
      type: 'assistant',
      uuid: 'u',
      message: { content: Array.from({ length: 2000 }, () => ({ type: 'text', text: 'x' })) }
    })
  )
  const controller = new AbortController()
  const bound = payloadBounds.boundLegacyImportBlock
  let started = false
  let turn = false
  vi.spyOn(payloadBounds, 'boundLegacyImportBlock').mockImplementation((...args) => {
    if (!started) {
      started = true
      setImmediate(() => {
        turn = true
        controller.abort(false)
      })
    }
    return bound(...args)
  })
  const journal = await journals.open({
    stateDirectory: join(root, 'state'),
    identity: {
      sessionId: 'session',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'claude',
      providerHandle: claudeProviderHandle('session', null)
    }
  })
  const before = journal.snapshot()
  const cursor = journal.cursor()
  const result = await importLegacyTranscriptIntoJournal({
    journal,
    fence: 1,
    agent: 'claude',
    sessionId: 'session',
    options: { filePath, signal: controller.signal }
  })
  expect(started).toBe(true)
  expect(turn).toBe(true)
  expect(result).toEqual({ ok: false, error: 'The operation was aborted.' })
  expect(journal.cursor()).toEqual(cursor)
  expect(journal.snapshot()).toEqual(before)
  expect(
    await prepareLegacyTranscriptImport({
      agent: 'claude',
      sessionId: 'session',
      options: { filePath }
    })
  ).toMatchObject({ ok: true, items: [{ body: { kind: 'message', role: 'assistant' } }] })
})
