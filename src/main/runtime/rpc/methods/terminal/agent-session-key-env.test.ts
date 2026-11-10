import { afterEach, describe, expect, it, vi } from 'vitest'
import { withKeyEnvFolded } from './agent-session'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('carried agent keys on the host', () => {
  it('folds them into the launch env on an ordinary host', () => {
    expect(withKeyEnvFolded({ keyEnv: { GEMINI_API_KEY: 'AIzaSy-real' } })).toEqual({
      keyEnv: undefined,
      accountEnv: { GEMINI_API_KEY: 'AIzaSy-real' }
    })
  })

  it('drops them on an Orca Cloud VM', () => {
    vi.stubEnv('ORCA_IS_CLOUD', '1')
    expect(
      withKeyEnvFolded({ keyEnv: { GEMINI_API_KEY: 'AIzaSy-real' }, accountEnv: { X: '1' } })
    ).toEqual({
      keyEnv: undefined,
      accountEnv: { X: '1' }
    })
  })
})
