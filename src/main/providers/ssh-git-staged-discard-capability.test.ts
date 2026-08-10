import { describe, expect, it, vi } from 'vitest'
import { GIT_STAGED_DISCARD_OPERATION_VERSION } from '../../shared/protocol-version'
import { SshGitStagedDiscardCapability } from './ssh-git-staged-discard-capability'

describe('SSH staged discard capability', () => {
  it('caches an exact positive owner proof', async () => {
    const request = vi.fn().mockResolvedValue({
      stagedDiscardOperationVersion: GIT_STAGED_DISCARD_OPERATION_VERSION
    })
    const capability = new SshGitStagedDiscardCapability({ request } as never)

    await expect(capability.supports()).resolves.toBe(true)
    await expect(capability.supports()).resolves.toBe(true)

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('git.getCapabilities', undefined, { timeoutMs: 5_000 })
  })

  it.each([
    undefined,
    {},
    { stagedDiscardOperationVersion: '1' },
    { stagedDiscardOperationVersion: 1 }
  ])('rejects and re-probes absent, malformed, or mismatched proof %#', async (result) => {
    const request = vi.fn().mockResolvedValue(result)
    const capability = new SshGitStagedDiscardCapability({ request } as never)

    await expect(capability.supports()).resolves.toBe(false)
    await expect(capability.supports()).resolves.toBe(false)

    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not evict a shared positive probe when one waiter aborts', async () => {
    let resolveProbe!: (value: unknown) => void
    const request = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve
      })
    )
    const capability = new SshGitStagedDiscardCapability({ request } as never)
    const controller = new AbortController()
    const canceled = capability.supports({ signal: controller.signal })
    const surviving = capability.supports()
    controller.abort()
    resolveProbe({ stagedDiscardOperationVersion: GIT_STAGED_DISCARD_OPERATION_VERSION })

    await expect(canceled).resolves.toBe(false)
    await expect(surviving).resolves.toBe(true)
    await expect(capability.supports()).resolves.toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
