import { describe, expect, it } from 'vitest'
import {
  DaemonProtocolError,
  decodeDaemonResponseError,
  SessionNotFoundError
} from './daemon-errors'

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
