import { describe, expect, it } from 'vitest'
import { isSafePtySessionId } from '../pty-session-id'

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
