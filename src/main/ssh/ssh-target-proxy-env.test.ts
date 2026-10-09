import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { createSshTargetProxyEnvResolver } from './ssh-target-proxy-env'

describe('createSshTargetProxyEnvResolver', () => {
  // Why: the feature's main promise — a proxy edit on a saved target reaches the
  // NEXT terminal without reconnecting — lives in this re-read-per-call contract.
  it('re-reads the target per call so a proxy edit applies without a reconnect', () => {
    let target: SshTarget | undefined = {
      id: 'ssh-1',
      label: 'Lab',
      host: 'lab.example.com',
      port: 22,
      username: 'deploy'
    }
    const resolve = createSshTargetProxyEnvResolver(() => target)

    expect(resolve()).toEqual({})

    target = { ...target, httpProxyUrl: 'http://proxy.lan:3128' }
    expect(resolve()).toMatchObject({ HTTP_PROXY: 'http://proxy.lan:3128' })

    target = {
      ...target,
      httpProxyUrl: 'http://proxy.lan:3129',
      httpProxyBypassRules: 'localhost'
    }
    expect(resolve()).toMatchObject({
      HTTP_PROXY: 'http://proxy.lan:3129',
      NO_PROXY: 'localhost'
    })

    target = { ...target, httpProxyUrl: undefined }
    expect(resolve()).toEqual({})
  })

  it('resolves no proxy for a missing target', () => {
    const resolve = createSshTargetProxyEnvResolver(() => undefined)
    expect(resolve()).toEqual({})
  })
})
