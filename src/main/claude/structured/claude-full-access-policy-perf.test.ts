import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { createClaudeFullAccessPolicy } from './claude-full-access-policy'

const SESSION = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'
const CHUNK_BYTES = 1000
const MAX_PENDING_REQUESTS = 256

afterEach(() => {
  vi.restoreAllMocks()
})

const line = (frame: Record<string, unknown>): string => `${JSON.stringify(frame)}\n`

it.each([300, 3000])('bounds stdout policy work over %i frames and one long line', (frames) => {
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
  const parse = vi.spyOn(JSON, 'parse')

  const started = performance.now()
  // Fixed-size chunks split frames and multibyte characters, as pipe reads do.
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    policy.observe(bytes.subarray(offset, offset + CHUNK_BYTES))
  }
  const elapsedMs = performance.now() - started
  const parses = parse.mock.calls.length
  parse.mockRestore()
  console.info('claude-full-access-policy-perf', { frames, bytes: bytes.length, parses, elapsedMs })

  // Only mode reports and permission requests are parsed; deltas and the long line never are.
  expect(parses).toBe(expected.length * 2)
  expect(policy.retained()).toEqual({
    partialChars: 0,
    requests: Math.min(expected.length, MAX_PENDING_REQUESTS)
  })
  for (const [requestId, fullAccess] of expected.slice(-MAX_PENDING_REQUESTS)) {
    expect(policy.allows(requestId), requestId).toBe(fullAccess)
  }
  expect(policy.retained()).toEqual({ partialChars: 0, requests: 0 })
  // Rescanning the growing long line per chunk would take seconds at the larger size.
  expect(elapsedMs).toBeLessThan(2_000)
})
