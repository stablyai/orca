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

  it('uses a new generation after unregister without retaining the disconnected id', () => {
    const before = getSshGitProviderGeneration(connectionId)
    registerSshGitProvider(connectionId, {} as never)
    const registered = getSshGitProviderGeneration(connectionId)
    unregisterSshGitProvider(connectionId)
    const unregistered = getSshGitProviderGeneration(connectionId)
    registerSshGitProvider(connectionId, {} as never)
    const reRegistered = getSshGitProviderGeneration(connectionId)

    expect(registered).toBeGreaterThan(before)
    expect(unregistered).toBe(0)
    expect(reRegistered).toBeGreaterThan(registered)
  })

  it('releases generations for thousands of unique disconnected ids', () => {
    for (let index = 0; index < 10_000; index += 1) {
      const id = `transient-${index}`
      registerSshGitProvider(id, {} as never)
      expect(getSshGitProviderGeneration(id)).toBeGreaterThan(0)
      unregisterSshGitProvider(id)
      expect(getSshGitProviderGeneration(id)).toBe(0)
    }
  })
})
