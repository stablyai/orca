import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSshPtyProvider } from '../ipc/pty'
import {
  requireGitProviderForHost,
  resolveFilesystemRouteForHost,
  resolveGitRouteForHost
} from '../providers/execution-host-provider-dispatch'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  getSshGitProvider,
  getSshGitProviderGeneration,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { registerSshHostProviders, retireSshHostProviders } from './ssh-host-provider-set'
import { clearSshPlainSshMode, setSshPlainSshMode } from './ssh-plain-ssh-mode'

const targetId = 'host-provider-set-target'

type ProviderSet = Parameters<typeof registerSshHostProviders>[1]

function providerSet(withGit = true) {
  const disposePty = vi.fn()
  const disposeFs = vi.fn()
  const stub = {
    pty: { dispose: disposePty },
    fs: { dispose: disposeFs },
    git: withGit ? {} : null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the set module only stores these stubs and calls `dispose`.
  const set = stub as unknown as ProviderSet
  return { set, disposePty, disposeFs }
}

describe('SSH host provider set', () => {
  afterEach(() => {
    retireSshHostProviders(targetId)
    clearSshPlainSshMode(targetId)
  })

  it('registers and retires every provider for the host together', () => {
    const { set, disposePty, disposeFs } = providerSet()
    registerSshHostProviders(targetId, set)
    expect(getSshPtyProvider(targetId)).toBe(set.pty)
    expect(getSshFilesystemProvider(targetId)).toBe(set.fs)
    expect(getSshGitProvider(targetId)).toBe(set.git)

    retireSshHostProviders(targetId)
    expect(disposePty).toHaveBeenCalledOnce()
    expect(disposeFs).toHaveBeenCalledOnce()
    expect(getSshPtyProvider(targetId)).toBeUndefined()
    expect(getSshFilesystemProvider(targetId)).toBeUndefined()
    expect(getSshGitProvider(targetId)).toBeUndefined()
  })

  it('a set without git clears an earlier git provider and reports git as unsupported', () => {
    registerSshHostProviders(targetId, providerSet().set)
    const generationBefore = getSshGitProviderGeneration(targetId)
    setSshPlainSshMode(targetId, { reason: 'no_runtime', message: 'm' })
    registerSshHostProviders(targetId, providerSet(false).set)

    expect(getSshGitProvider(targetId)).toBeUndefined()
    expect(getSshGitProviderGeneration(targetId)).toBeGreaterThan(generationBefore)
    expect(resolveFilesystemRouteForHost(`ssh:${targetId}`)).toMatchObject({ kind: 'ssh' })
    expect(resolveGitRouteForHost(`ssh:${targetId}`)).toMatchObject({ provider: null })
    expect(() => requireGitProviderForHost(`ssh:${targetId}`)).toThrow(
      'Git needs the Orca remote server'
    )
    clearSshPlainSshMode(targetId)
    expect(() => requireGitProviderForHost(`ssh:${targetId}`)).toThrow(
      SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
    )
  })

  it('an owner whose set was replaced disposes only its own providers and leaves the host', () => {
    const stale = providerSet(false)
    const { set: current, disposePty: disposeCurrentPty } = providerSet()
    registerSshHostProviders(targetId, stale.set)
    registerSshHostProviders(targetId, current)

    retireSshHostProviders(targetId, stale.set)

    expect(stale.disposePty).toHaveBeenCalledOnce()
    expect(stale.disposeFs).toHaveBeenCalledOnce()
    expect(disposeCurrentPty).not.toHaveBeenCalled()
    expect(getSshPtyProvider(targetId)).toBe(current.pty)
    expect(getSshFilesystemProvider(targetId)).toBe(current.fs)
    expect(getSshGitProvider(targetId)).toBe(current.git)
  })
})
