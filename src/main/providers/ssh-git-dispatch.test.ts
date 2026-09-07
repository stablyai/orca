import { afterEach, describe, expect, it } from 'vitest'
import {
  getSshGitProviderGeneration,
  registerSshGitProvider,
  unregisterSshGitProvider
} from './ssh-git-dispatch'

describe('SSH Git provider registry', () => {
  const connectionId = 'ssh-generation-test'

  afterEach(() => {
    unregisterSshGitProvider(connectionId)
  })

  it('keeps provider generations monotonic across unregister and re-register', () => {
    const before = getSshGitProviderGeneration(connectionId)
    registerSshGitProvider(connectionId, {} as never)
    const registered = getSshGitProviderGeneration(connectionId)
    unregisterSshGitProvider(connectionId)
    const unregistered = getSshGitProviderGeneration(connectionId)
    registerSshGitProvider(connectionId, {} as never)
    const reRegistered = getSshGitProviderGeneration(connectionId)

    expect(registered).toBe(before + 1)
    expect(unregistered).toBe(registered + 1)
    expect(reRegistered).toBe(unregistered + 1)
  })
})
