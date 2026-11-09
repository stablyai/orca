import { describe, expect, it } from 'vitest'
import {
  isSafePtySessionId,
  normalizeFreshPtySessionId,
  ptySessionIdForAgentCreateOperation
} from '../pty-session-id'

const USER_DATA = '/tmp/orca-userdata'

describe('isSafePtySessionId', () => {
  it('rejects ids that traverse out of userData via deep ..', () => {
    expect(isSafePtySessionId('sub/../../etc/passwd', USER_DATA)).toBe(false)
  })

  it('rejects ids that resolve to the userData root itself', () => {
    // The data root itself is not a valid per-session storage key.
    expect(isSafePtySessionId('.', USER_DATA)).toBe(false)
  })
})

describe('terminal identity allocation', () => {
  it('keeps an unscoped operation replayable without truncating it into a numeric key', () => {
    expect(ptySessionIdForAgentCreateOperation(undefined, '12345678_different-operation')).toBe(
      'operation-12345678_different-operation'
    )
    expect(ptySessionIdForAgentCreateOperation(undefined, '12345678_other-operation')).toBe(
      'operation-12345678_other-operation'
    )
  })

  it('replaces explicitly new numeric hints once and preserves saved numeric restores', () => {
    const fresh = normalizeFreshPtySessionId({
      sessionId: ' 9 ',
      worktreeId: 'workspace',
      isNewSession: true
    })
    expect(fresh.sessionId).toMatch(/^workspace@@[a-f0-9]{8}$/)
    expect(normalizeFreshPtySessionId(fresh).sessionId).toBe(fresh.sessionId)
    expect(normalizeFreshPtySessionId({ sessionId: '9', worktreeId: 'workspace' }).sessionId).toBe(
      '9'
    )
  })
})
