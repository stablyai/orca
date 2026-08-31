import { describe, expect, it } from 'vitest'
import type { RuntimeTransportMetadata } from '../../shared/runtime-bootstrap'
import { classifyLocalRuntimeUnreachable } from './local-runtime-unreachable-reason'
import { RuntimeClientError, RuntimeRpcFailureError, RuntimeTransportError } from './types'

const PIPE: RuntimeTransportMetadata = {
  kind: 'named-pipe',
  endpoint: '\\\\.\\pipe\\orca-26272-abcd'
}
const SOCKET: RuntimeTransportMetadata = { kind: 'unix', endpoint: '/tmp/orca/o-1-ab.sock' }

function connectError(osErrorCode: string | null): RuntimeTransportError {
  return new RuntimeTransportError('runtime_unavailable', 'generic', 'connect', osErrorCode)
}

describe('classifyLocalRuntimeUnreachable', () => {
  it.each([
    ['ENOENT', 'endpoint_missing'],
    ['EACCES', 'endpoint_permission_denied'],
    ['EPERM', 'endpoint_permission_denied'],
    ['ECONNREFUSED', 'connection_refused'],
    ['ECONNRESET', 'connection_closed'],
    ['EPIPE', 'connection_closed']
  ] as const)('maps a %s connect failure to %s', (osErrorCode, expected) => {
    const reason = classifyLocalRuntimeUnreachable(connectError(osErrorCode), PIPE, 1000)
    expect(reason.code).toBe(expected)
    expect(reason.osErrorCode).toBe(osErrorCode)
  })

  it('classifies a peer close by phase, not by an errno the OS never reported', () => {
    const reason = classifyLocalRuntimeUnreachable(
      new RuntimeTransportError('runtime_unavailable', 'closed', 'peer_closed'),
      SOCKET,
      1000
    )
    expect(reason.code).toBe('connection_closed')
    expect(reason.osErrorCode).toBeUndefined()
  })

  it('maps a client-side timeout to request_timeout and names the budget', () => {
    const reason = classifyLocalRuntimeUnreachable(
      new RuntimeClientError('runtime_timeout', 'timed out'),
      SOCKET,
      1234
    )
    expect(reason.code).toBe('request_timeout')
    expect(reason.message).toContain('1234ms')
  })

  it('maps an unreadable frame to invalid_response', () => {
    const reason = classifyLocalRuntimeUnreachable(
      new RuntimeClientError('invalid_runtime_response', 'bad frame'),
      SOCKET,
      1000
    )
    expect(reason.code).toBe('invalid_response')
  })

  // Why: a runtime that answers and declines is reachable. Routing it to a
  // transport code would aim sandbox/permission advice at an auth failure.
  it('quotes the runtime error when the runtime answers and refuses', () => {
    const reason = classifyLocalRuntimeUnreachable(
      new RuntimeRpcFailureError({
        id: 'req',
        ok: false,
        error: { code: 'unauthorized', message: 'Auth token is not valid.' }
      }),
      SOCKET,
      1000
    )
    expect(reason.code).toBe('request_rejected')
    expect(reason.message).toContain('unauthorized')
    expect(reason.message).toContain('Auth token is not valid.')
  })

  it('falls back to unknown without inventing a cause', () => {
    const reason = classifyLocalRuntimeUnreachable(new Error('boom'), SOCKET, 1000)
    expect(reason.code).toBe('unknown')
    expect(reason.osErrorCode).toBeUndefined()
  })

  it('always reports the endpoint it actually tried, with the right noun', () => {
    expect(classifyLocalRuntimeUnreachable(connectError('EACCES'), PIPE, 1000)).toMatchObject({
      endpoint: PIPE.endpoint,
      endpointKind: 'named-pipe'
    })
    expect(classifyLocalRuntimeUnreachable(connectError('EACCES'), PIPE, 1000).message).toContain(
      'named pipe'
    )
    expect(classifyLocalRuntimeUnreachable(connectError('EACCES'), SOCKET, 1000).message).toContain(
      'socket'
    )
  })

  it('does not claim a permission-denied endpoint exists', () => {
    const reason = classifyLocalRuntimeUnreachable(connectError('EACCES'), PIPE, 1000)

    expect(reason.message).not.toMatch(/\bexists\b/i)
    expect(reason.message).toContain('OS denied')
  })

  // The reported Windows 10 incident: the app process is alive, the pipe is not
  // openable from this process. The guidance must name the isolation possibilities
  // rather than telling the user to keep waiting.
  it('offers session/sandbox guidance for a hidden Windows named pipe', () => {
    const reason = classifyLocalRuntimeUnreachable(connectError('ENOENT'), PIPE, 1000)
    expect(reason.message).toContain(PIPE.endpoint)
    expect(reason.message).toMatch(/sandbox/i)
    expect(reason.message).toMatch(/session/i)
  })
})
