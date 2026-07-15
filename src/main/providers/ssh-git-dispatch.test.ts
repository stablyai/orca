import { afterEach, describe, expect, it } from 'vitest'
import {
  getSshGitProvider,
  getSshGitProviderRegistrationId,
  registerSshGitProvider,
  unregisterSshGitProvider
} from './ssh-git-dispatch'

describe('SSH git provider registration identity', () => {
  afterEach(() => unregisterSshGitProvider('conn-1'))

  it('changes identity when the same connection id and provider are registered again', () => {
    const provider = {} as never
    registerSshGitProvider('conn-1', provider)
    const firstRegistrationId = getSshGitProviderRegistrationId('conn-1')

    registerSshGitProvider('conn-1', provider)

    expect(getSshGitProvider('conn-1')).toBe(provider)
    expect(getSshGitProviderRegistrationId('conn-1')).not.toBe(firstRegistrationId)
  })

  it('removes provider and lifecycle identity together', () => {
    registerSshGitProvider('conn-1', {} as never)

    unregisterSshGitProvider('conn-1')

    expect(getSshGitProvider('conn-1')).toBeUndefined()
    expect(getSshGitProviderRegistrationId('conn-1')).toBeUndefined()
  })
})
