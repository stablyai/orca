import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { createClaudeFullAccessPolicy } from './claude-full-access-policy'

const SESSION = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'
const CHUNK_BYTES = 1000

afterEach(() => {
  vi.restoreAllMocks()
})

const line = (frame: Record<string, unknown>): string => `${JSON.stringify(frame)}\n`

type Work = { chars: number; parses: number; newlineSearched: number; screened: number }

/** Drives the real policy and counts the characters it searches, so a rescan cannot hide in time. */
function observeWire(frames: number): Work {
  const delta = line({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok — '.repeat(8) } },
    session_id: SESSION
  })
  // A tool result spanning thousands of chunks, as large file reads do.
  const longLine = line({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: 'y'.repeat(frames * 3000) }]
    },
    session_id: SESSION
  })
  const expected: [string, boolean][] = []
  let wire = ''
  for (let index = 0; index < frames; index += 1) {
    wire += delta
    if (index % 10 === 0) {
      const mode = index % 20 === 0 ? 'plan' : 'bypassPermissions'
      wire += line({ type: 'system', subtype: 'status', permissionMode: mode, session_id: SESSION })
      wire += line({
        type: 'control_request',
        request_id: `r${index}`,
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: `t${index}` }
      })
      expected.push([`r${index}`, mode === 'bypassPermissions'])
    }
    if (index === frames / 2) {
      wire += longLine
    }
  }
  const bytes = Buffer.from(wire)
  const policy = createClaudeFullAccessPolicy(SESSION)
  // Node's own internals keep their original string methods, so these count only the policy's calls.
  const { indexOf, includes } = String.prototype
  let newlineSearched = 0
  let screened = 0
  const parse = vi.spyOn(JSON, 'parse')
  const searches = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
    this: string,
    search: string,
    position?: number
  ) {
    const found = indexOf.call(this, search, position)
    newlineSearched += (found === -1 ? this.length : found + search.length) - (position ?? 0)
    return found
  })
  const screens = vi.spyOn(String.prototype, 'includes').mockImplementation(function (
    this: string,
    search: string,
    position?: number
  ) {
    screened += this.length
    return includes.call(this, search, position)
  })

  const started = performance.now()
  // Fixed-size chunks split frames and multibyte characters, as pipe reads do.
  try {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      policy.observe(bytes.subarray(offset, offset + CHUNK_BYTES))
    }
  } finally {
    searches.mockRestore()
    screens.mockRestore()
  }
  const elapsedMs = performance.now() - started
  const parses = parse.mock.calls.length
  parse.mockRestore()
  const work = { chars: wire.length, parses, newlineSearched, screened }
  console.info('claude-full-access-policy-perf', {
    frames,
    bytes: bytes.length,
    ...work,
    elapsedMs
  })

  // Newlines are looked for in new text only, and each completed line is screened at most twice,
  // checked per size so a rescanning policy fails here before the larger run exhausts memory.
  expect(newlineSearched).toBeLessThanOrEqual(wire.length)
  expect(screened).toBeLessThanOrEqual(2 * wire.length)
  // Only mode reports and permission requests are parsed; deltas and the long line never are.
  expect(parses).toBe(expected.length * 2)
  // Unread requests stay until the SDK hands each to canUseTool, however many queue up.
  expect(policy.retained()).toEqual({ partialChars: 0, requests: expected.length })
  for (const [requestId, fullAccess] of expected) {
    expect(policy.allows(requestId), requestId).toBe(fullAccess)
  }
  expect(policy.retained()).toEqual({ partialChars: 0, requests: 0 })
  return work
}

it('searches each stdout character a bounded number of times, however long a line grows', () => {
  const small = observeWire(300)
  const large = observeWire(3000)
  // Ten times the output, including a ten times longer line, costs ten times the work.
  expect(large.newlineSearched).toBeLessThanOrEqual(10 * small.newlineSearched + CHUNK_BYTES)
  expect(large.screened).toBeLessThanOrEqual(10 * small.screened + CHUNK_BYTES)
  expect(large.parses).toBe(10 * small.parses)
})
