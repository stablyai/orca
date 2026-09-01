import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { printResult } from '../format'
import { HANDLER_GROUPS } from '../handler-group-manifest'
import { ORCHESTRATION_HANDLERS } from './orchestration'
import {
  ORCHESTRATION_DISPATCH_HANDLER,
  ORCHESTRATION_DISPATCH_INSPECTION_HANDLERS
} from './orchestration/dispatch-handlers'
import { getOptionalStructuredMessagePayload } from './orchestration/message-payload'
import { getOptionalPositiveIntegerValueFlag } from './orchestration/numeric-flags'
import { formatWorkerRead, formatWorkerRelease } from './orchestration/worker-output'

describe('extracted orchestration flag parsing', () => {
  it('serializes phase and omits empty CSV entries', () => {
    const payload = getOptionalStructuredMessagePayload(
      new Map([
        ['phase', 'verification'],
        ['files-modified', ' src/a.ts, ,src/b.ts, ']
      ])
    )

    expect(JSON.parse(payload ?? '')).toEqual({
      filesModified: ['src/a.ts', 'src/b.ts'],
      phase: 'verification'
    })
  })

  it('rejects unsafe positive integers before dispatch', () => {
    expect(() =>
      getOptionalPositiveIntegerValueFlag(
        new Map([['timeout-ms', '9007199254740992']]),
        'timeout-ms'
      )
    ).toThrow('Invalid positive safe integer for --timeout-ms')
  })
})

it('composes handlers in the canonical command order', () => {
  const declared = HANDLER_GROUPS.find((group) => group.name === 'orchestration')?.keys
  expect(Object.keys(ORCHESTRATION_HANDLERS)).toEqual(declared)
})

describe('extracted orchestration worker formatting', () => {
  it('renders terminal tails without changing line boundaries', () => {
    expect(
      formatWorkerRead({
        dispatchId: 'dispatch_1',
        terminal: { tail: ['first', '', 'third'] }
      } as never)
    ).toBe('first\n\nthird')
  })

  it('renders transcript blocks and survives unserializable tool input', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular

    expect(
      formatWorkerRead({
        source: 'transcript',
        transcript: {
          messages: [
            {
              id: 'message_1',
              role: 'assistant',
              blocks: [
                { type: 'text', text: 'working' },
                { type: 'tool-call', name: 'inspect', input: circular },
                { type: 'tool-result', output: 'failed', isError: true },
                { type: 'image-ref', url: 'https://example.test/proof.png' }
              ],
              timestamp: null,
              source: 'transcript'
            }
          ]
        }
      } as never)
    ).toBe(
      '[assistant] working\n[tool inspect] [unserializable input]\n[tool result error] failed\n[image] https://example.test/proof.png'
    )
  })

  it('renders release evidence in receipt order', () => {
    expect(
      formatWorkerRelease({
        dispatchId: 'dispatch_1',
        state: 'release_unknown',
        reason: 'host_unreachable',
        processAction: 'unverifiable',
        archive: { source: 'transcript', status: 'saved' },
        lastError: 'transport closed',
        recovery: 'Reconnect and retry.'
      })
    ).toBe(
      'Worker dispatch_1 terminal [release_unknown] reason=host_unreachable process=unverifiable\n' +
        'archive transcript [saved]\ntransport closed\nReconnect and retry.'
    )
  })
})

describe('extracted orchestration dispatch handlers', () => {
  const call = vi.fn()

  beforeEach(() => {
    call.mockReset()
    vi.mocked(printResult).mockReset()
  })

  it('allows a dry run without a recipient and returns only its preamble', async () => {
    call.mockResolvedValue({
      result: { dispatch: null, dryRun: true, preamble: 'preview preamble' }
    })

    await ORCHESTRATION_DISPATCH_HANDLER['orchestration dispatch']({
      flags: new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['from', 'terminal_coordinator'],
        ['dry-run', true],
        ['return-preamble', true]
      ]),
      client: { call },
      cwd: '/repo',
      json: false
    } as never)

    expect(call).toHaveBeenCalledWith('orchestration.dispatch', {
      task: 'task_1',
      run: undefined,
      to: undefined,
      from: 'terminal_coordinator',
      inject: undefined,
      dryRun: true,
      returnPreamble: true,
      devMode: false
    })
    expect(renderedValue({ dispatch: null, dryRun: true, preamble: 'preview preamble' })).toBe(
      'preview preamble'
    )
  })

  it('does not resolve coordinator identity for a non-preamble dispatch lookup', async () => {
    call.mockResolvedValue({ result: { dispatch: null } })

    await ORCHESTRATION_DISPATCH_INSPECTION_HANDLERS['orchestration dispatch-show']({
      flags: new Map([['task', 'task_1']]),
      client: { call },
      cwd: '/repo',
      json: false
    } as never)

    expect(call).toHaveBeenCalledWith('orchestration.dispatchShow', {
      task: 'task_1',
      preamble: undefined,
      from: undefined,
      devMode: false
    })
    expect(renderedValue({ dispatch: null })).toBe('No dispatch context found.')
  })
})

function renderedValue(value: unknown): string {
  const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as (result: unknown) => string
  return formatter(value)
}
