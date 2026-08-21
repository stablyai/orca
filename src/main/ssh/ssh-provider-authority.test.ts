import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertSshMutationExpectation,
  resetSshConnectionGenerations,
  setSshConnectionGeneration
} from './ssh-connection-generation'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority,
  registerSshProviderRequestAbort,
  resetSshProviderAuthorities,
  rotateSshProviderAuthority
} from './ssh-provider-authority'

describe('SSH provider authority', () => {
  beforeEach(() => {
    resetSshConnectionGenerations()
    resetSshProviderAuthorities()
  })

  it('rotates provider epoch and connection generation atomically', () => {
    const initial = getSshProviderAuthority('ssh-a')
    const rotated = rotateSshProviderAuthority('ssh-a')

    expect(rotated).toEqual({
      targetId: 'ssh-a',
      providerEpoch: expect.any(String),
      connectionGeneration: initial.connectionGeneration + 1
    })
    expect(rotated.providerEpoch).not.toBe(initial.providerEpoch)
    expect(getSshProviderAuthority('ssh-a')).toEqual(rotated)
    expect(() =>
      assertSshMutationExpectation('ssh-a', 'ssh-a', initial.connectionGeneration)
    ).toThrow('SSH connection changed; refresh and try again')
    expect(() =>
      assertSshMutationExpectation('ssh-a', 'ssh-a', rotated.connectionGeneration)
    ).not.toThrow()
  })

  it('rejects a stale authority by full-pair equality', () => {
    const stale = getSshProviderAuthority('ssh-a')
    rotateSshProviderAuthority('ssh-a')

    expect(isCurrentSshProviderAuthority(stale)).toBe(false)
    expect(isCurrentSshProviderAuthority(getSshProviderAuthority('ssh-a'))).toBe(true)
  })

  it('checks unknown authority without allocating provider state', () => {
    const sequence = (authority: ReturnType<typeof getSshProviderAuthority>): number =>
      Number.parseInt(authority.providerEpoch.split('-').at(-1) ?? '', 36)
    const before = getSshProviderAuthority('before-probe')

    expect(
      isCurrentSshProviderAuthority({
        targetId: 'unknown-target',
        providerEpoch: 'untrusted-epoch' as typeof before.providerEpoch,
        connectionGeneration: 0
      })
    ).toBe(false)

    const after = getSshProviderAuthority('after-probe')
    expect(sequence(after) - sequence(before)).toBe(1)
  })

  it('aborts every old-authority provider request once with target isolation', () => {
    const authorityA = getSshProviderAuthority('ssh-a')
    const authorityB = getSshProviderAuthority('ssh-b')
    const controllersA = [new AbortController(), new AbortController()]
    const controllerB = new AbortController()
    const abortsA = controllersA.map(() => vi.fn())
    const abortB = vi.fn()
    controllersA.forEach((controller, index) => {
      controller.signal.addEventListener('abort', abortsA[index])
      registerSshProviderRequestAbort(authorityA, controller)
    })
    controllerB.signal.addEventListener('abort', abortB)
    registerSshProviderRequestAbort(authorityB, controllerB)

    rotateSshProviderAuthority('ssh-a')
    rotateSshProviderAuthority('ssh-a')

    expect(abortsA[0]).toHaveBeenCalledOnce()
    expect(abortsA[1]).toHaveBeenCalledOnce()
    expect(abortB).not.toHaveBeenCalled()
    rotateSshProviderAuthority('ssh-b')
    expect(abortB).toHaveBeenCalledOnce()
  })

  it('revokes every target when one target rolls the generation session scope', () => {
    setSshConnectionGeneration('ssh-a', 2 ** 13 - 1)
    const authorityA = getSshProviderAuthority('ssh-a')
    const authorityB = getSshProviderAuthority('ssh-b')
    const controllerA = new AbortController()
    const controllerB = new AbortController()
    const abortA = vi.spyOn(controllerA, 'abort')
    const abortB = vi.spyOn(controllerB, 'abort')
    let oldAuthoritiesWereCurrent = true
    controllerA.signal.addEventListener('abort', () => {
      oldAuthoritiesWereCurrent =
        isCurrentSshProviderAuthority(authorityA) || isCurrentSshProviderAuthority(authorityB)
    })
    registerSshProviderRequestAbort(authorityA, controllerA)
    registerSshProviderRequestAbort(authorityB, controllerB)

    const rotated = rotateSshProviderAuthority('ssh-a')

    expect(rotated.connectionGeneration).toBe(2 ** 13 + 1)
    expect(abortA).toHaveBeenCalledOnce()
    expect(abortB).toHaveBeenCalledOnce()
    expect(oldAuthoritiesWereCurrent).toBe(false)
    expect(isCurrentSshProviderAuthority(authorityA)).toBe(false)
    expect(isCurrentSshProviderAuthority(authorityB)).toBe(false)
  })

  it('rejects old-authority registration reentered from an abort callback', () => {
    const oldAuthority = getSshProviderAuthority('ssh-a')
    const controllerA = new AbortController()
    const controllerB = new AbortController()
    const abortA = vi.fn()
    let oldAuthorityWasCurrent = true

    controllerA.signal.addEventListener('abort', () => {
      abortA()
      oldAuthorityWasCurrent = isCurrentSshProviderAuthority(oldAuthority)
      registerSshProviderRequestAbort(oldAuthority, controllerB)
    })
    registerSshProviderRequestAbort(oldAuthority, controllerA)

    rotateSshProviderAuthority('ssh-a')
    rotateSshProviderAuthority('ssh-a')

    expect(abortA).toHaveBeenCalledOnce()
    expect(oldAuthorityWasCurrent).toBe(false)
    expect(controllerB.signal.aborted).toBe(false)
  })

  it('removes settled and explicitly aborted registrations before later rotation', () => {
    const authority = getSshProviderAuthority('ssh-a')
    const settled = new AbortController()
    const explicitlyAborted = new AbortController()
    const settledAbort = vi.spyOn(settled, 'abort')
    const explicitAbort = vi.spyOn(explicitlyAborted, 'abort')
    const removeSettled = registerSshProviderRequestAbort(authority, settled)
    registerSshProviderRequestAbort(authority, explicitlyAborted)

    removeSettled()
    explicitlyAborted.abort()
    rotateSshProviderAuthority('ssh-a')

    expect(settledAbort).not.toHaveBeenCalled()
    expect(explicitAbort).toHaveBeenCalledOnce()
  })

  it('aborts and clears registrations during reset isolation', () => {
    const oldAuthority = getSshProviderAuthority('ssh-a')
    const oldController = new AbortController()
    const oldAbort = vi.spyOn(oldController, 'abort')
    registerSshProviderRequestAbort(oldAuthority, oldController)

    resetSshProviderAuthorities()
    const newAuthority = getSshProviderAuthority('ssh-a')
    const newController = new AbortController()
    const newAbort = vi.spyOn(newController, 'abort')
    registerSshProviderRequestAbort(newAuthority, newController)
    rotateSshProviderAuthority('ssh-a')

    expect(oldAbort).toHaveBeenCalledOnce()
    expect(newAbort).toHaveBeenCalledOnce()
  })
})
