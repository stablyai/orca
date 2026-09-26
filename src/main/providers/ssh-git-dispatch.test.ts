import { afterEach, describe, expect, it } from 'vitest'
import {
  _getSshGitProviderGenerationCacheSize,
  getSshGitProvider,
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

  it('bounds retired connection generations', () => {
    registerSshGitProvider(connectionId, {} as never)
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      throw new Error('test provider was not registered')
    }
    for (let index = 0; index < 600; index += 1) {
      const id = `retired-${index}`
      registerSshGitProvider(id, provider)
      unregisterSshGitProvider(id)
    }

    expect(_getSshGitProviderGenerationCacheSize()).toBeLessThanOrEqual(512)
  })

  it('does not reuse a generation after the target leaves both bounded maps', () => {
    registerSshGitProvider(connectionId, {} as never)
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      throw new Error('test provider was not registered')
    }
    const beforeChurn = getSshGitProviderGeneration(connectionId)
    for (let index = 0; index < 1_100; index += 1) {
      const id = `churn-${index}`
      registerSshGitProvider(id, provider)
      unregisterSshGitProvider(id)
    }
    unregisterSshGitProvider(connectionId)
    registerSshGitProvider(connectionId, {} as never)

    expect(getSshGitProviderGeneration(connectionId)).toBeGreaterThan(beforeChurn)
  })
})
