import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultUserDataPath } from './metadata'
import { RuntimeClientError } from './types'

const CANDIDATE = '/tmp/orca-pkgb-pass-1787883756'
const NATIVE_MAC = '/Users/someone/Library/Application Support/orca'

describe('a candidate-scoped invocation never silently becomes a native one', () => {
  const clear = (): void => {
    // The Orca pane this suite may run inside exports the NATIVE state root, and
    // that ambient value is precisely what used to win.
    delete process.env.ORCA_USER_DATA_PATH
    delete process.env.ORCA_DEV_USER_DATA_PATH
  }
  beforeEach(clear)
  afterEach(clear)

  it('NEGATIVE CONTROL: the dev variable alone no longer falls through to the packaged app', () => {
    // The incident: a certification command exported only ORCA_DEV_USER_DATA_PATH,
    // this resolver read only ORCA_USER_DATA_PATH, and the call reached the
    // NATIVE runtime's socket.
    process.env.ORCA_DEV_USER_DATA_PATH = CANDIDATE
    expect(getDefaultUserDataPath('darwin', '/Users/someone')).toBe(CANDIDATE)
    expect(getDefaultUserDataPath('darwin', '/Users/someone')).not.toBe(NATIVE_MAC)
  })

  it('refuses rather than picking a winner when the two variables disagree', () => {
    process.env.ORCA_USER_DATA_PATH = CANDIDATE
    process.env.ORCA_DEV_USER_DATA_PATH = '/tmp/orca-pkgb-other'
    expect(() => getDefaultUserDataPath('darwin', '/Users/someone')).toThrow(RuntimeClientError)
    expect(() => getDefaultUserDataPath('darwin', '/Users/someone')).toThrow(
      /different runtimes; refusing to guess/
    )
  })

  it('accepts the pair the candidate launcher actually exports', () => {
    process.env.ORCA_USER_DATA_PATH = CANDIDATE
    process.env.ORCA_DEV_USER_DATA_PATH = CANDIDATE
    expect(getDefaultUserDataPath('darwin', '/Users/someone')).toBe(CANDIDATE)
  })

  it('still resolves the packaged profile when neither variable is set', () => {
    expect(getDefaultUserDataPath('darwin', '/Users/someone')).toBe(NATIVE_MAC)
  })
})
