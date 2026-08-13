import { describe, expect, it } from 'vitest'
import {
  DaemonProtocolError,
  decodeDaemonResponseError,
  isDaemonEndpointGoneError,
  SessionNotFoundError,
  TerminalHostGoneError,
  TerminalSessionOwnerUnverifiedError
} from './daemon-errors'
import { isPtyWriteUnavailableError } from '../providers/pty-write-unavailable-error'
import { mapRuntimeError } from '../runtime/rpc/errors'

function socketError(code: string, syscall: string): Error & { code: string; syscall: string } {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall })
}

describe('decodeDaemonResponseError', () => {
  it('types the exact legacy session-absence response', () => {
    expect(decodeDaemonResponseError('Session not found: pty-1')).toBeInstanceOf(
      SessionNotFoundError
    )
  })

  it('keeps unrelated daemon failures non-authoritative', () => {
    expect(decodeDaemonResponseError('proxy failed: Session not found: pty-1')).toBeInstanceOf(
      DaemonProtocolError
    )
  })
})

describe('isDaemonEndpointGoneError', () => {
  it('recognizes a missing Windows named pipe', () => {
    const err = Object.assign(
      new Error('connect ENOENT \\\\?\\pipe\\orca-terminal-host-v30-14cb7f94b511'),
      { code: 'ENOENT', syscall: 'connect' }
    )
    expect(isDaemonEndpointGoneError(err)).toBe(true)
  })

  it('recognizes a refused socket', () => {
    expect(isDaemonEndpointGoneError(socketError('ECONNREFUSED', 'connect'))).toBe(true)
  })

  it('ignores a missing token file, which does not prove the endpoint is gone', () => {
    expect(isDaemonEndpointGoneError(socketError('ENOENT', 'open'))).toBe(false)
  })

  it('ignores connect failures that are not proof of absence', () => {
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EACCES']) {
      expect(isDaemonEndpointGoneError(socketError(code, 'connect'))).toBe(false)
    }
  })

  it('ignores non-socket errors and non-objects', () => {
    expect(isDaemonEndpointGoneError(new Error('Connection lost'))).toBe(false)
    expect(isDaemonEndpointGoneError('connect ENOENT')).toBe(false)
    expect(isDaemonEndpointGoneError(null)).toBe(false)
    expect(isDaemonEndpointGoneError(undefined)).toBe(false)
  })

  it('keeps the host-gone marker across runtime RPC error mapping', () => {
    const response = mapRuntimeError(
      'req-1',
      { runtimeId: 'runtime-1' },
      new TerminalHostGoneError()
    )

    expect(response.error).toEqual({ code: 'runtime_error', message: 'terminal_host_gone' })
  })
})

describe('TerminalSessionOwnerUnverifiedError classification', () => {
  const error = new TerminalSessionOwnerUnverifiedError('pty-1')

  it('reads as an unavailable write, so a throw mid-paste reaches the renderer', () => {
    // Without this the remaining chunks are dropped with no pty:writeUnavailable, and the pane
    // never re-attaches — a silent truncation the user has no way to attribute.
    expect(isPtyWriteUnavailableError(error)).toBe(true)
  })

  it('does not read as an already-gone session', () => {
    // The reason this is not a SessionNotFoundError: pty.ts's isPtyAlreadyGoneError matches
    // /Session not found/i and synthesizes an exit, which would report a session as dead
    // precisely when we could not establish that it was. Matching that predicate's shape here
    // rather than importing it, because it is private to the IPC layer.
    expect(/Session not found/i.test(error.message)).toBe(false)
    expect(/Session not found/i.test(new SessionNotFoundError('pty-1').message)).toBe(true)
  })

  it('keeps its own identity for callers that match on it', () => {
    expect(error).toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
    expect(error.name).toBe('TerminalSessionOwnerUnverifiedError')
  })
})
