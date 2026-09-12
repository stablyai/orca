import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => '/tmp/orca-captured-destination-test' },
  safeStorage: { isEncryptionAvailable: () => false }
}))

function setup() {
  let enabled = true
  const runtime = new OrcaRuntimeService(undefined, undefined, {
    runtimeId: identity.destinationRuntimeId,
    ptyOwnershipTransferMutationEnabled: () => enabled
  })
  const lifecycle = { prepareCapturedDestination: vi.fn() }
  const request = { identity, source: {}, model: {}, signal: new AbortController().signal }
  return {
    runtime,
    lifecycle,
    request,
    disable: () => {
      enabled = false
    }
  }
}

it('routes a capture through the installed host lifecycle without changing its request', async () => {
  const f = setup()
  f.runtime.installCapturedPtyDestinationLifecycle(f.lifecycle)
  const result = { published: true }
  f.lifecycle.prepareCapturedDestination.mockResolvedValue(result)
  expect(await f.runtime.prepareCapturedPtyDestination(f.request)).toBe(result)
  expect(f.lifecycle.prepareCapturedDestination).toHaveBeenCalledExactlyOnceWith(f.request)
})

it('reports catalog support only from the current enabled lifecycle', () => {
  const f = setup()
  expect(f.runtime.supportsCapturedCatalogPublication()).toBe(false)
  const removeLegacy = f.runtime.installCapturedPtyDestinationLifecycle(f.lifecycle)
  expect(f.runtime.supportsCapturedCatalogPublication()).toBe(false)
  removeLegacy()
  let available = true
  const remove = f.runtime.installCapturedPtyDestinationLifecycle({
    ...f.lifecycle,
    supportsCapturedCatalogPublication: () => available
  })
  expect(f.runtime.supportsCapturedCatalogPublication()).toBe(true)
  available = false
  expect(f.runtime.supportsCapturedCatalogPublication()).toBe(false)
  available = true
  f.disable()
  expect(f.runtime.supportsCapturedCatalogPublication()).toBe(false)
  remove()
  expect(f.runtime.supportsCapturedCatalogPublication()).toBe(false)
})

it('requires explicit recovery support on the installed lifecycle and revokes it on removal', () => {
  const f = setup()
  let recovery = true
  const remove = f.runtime.installCapturedPtyDestinationLifecycle({
    ...f.lifecycle,
    supportsCapturedCatalogPublication: () => true,
    inspectPublishedDestinationActivation: vi.fn(),
    retirePublishedSourceDelivery: vi.fn(),
    supportsCapturedSourceRetirementRecovery: () => recovery
  })
  expect(f.runtime.supportsCapturedSourceRetirementRecovery()).toBe(true)
  recovery = false
  expect(f.runtime.supportsCapturedSourceRetirementRecovery()).toBe(false)
  recovery = true
  f.disable()
  expect(f.runtime.supportsCapturedSourceRetirementRecovery()).toBe(false)
  remove()
  expect(f.runtime.supportsCapturedSourceRetirementRecovery()).toBe(false)
})

it('reports output coverage only with an enabled publication lifecycle and dedicated hook', () => {
  const f = setup()
  expect(f.runtime.supportsCapturedCatalogOutputCoverage()).toBe(false)
  const removeLegacy = f.runtime.installCapturedPtyDestinationLifecycle({
    ...f.lifecycle,
    supportsCapturedCatalogPublication: () => true,
    inspectPublishedDestinationActivation: vi.fn()
  })
  expect(f.runtime.supportsCapturedCatalogOutputCoverage()).toBe(false)
  removeLegacy()
  const remove = f.runtime.installCapturedPtyDestinationLifecycle({
    ...f.lifecycle,
    supportsCapturedCatalogPublication: () => true,
    inspectPublishedDestinationOutputCoverage: vi.fn()
  })
  expect(f.runtime.supportsCapturedCatalogOutputCoverage()).toBe(true)
  f.disable()
  expect(f.runtime.supportsCapturedCatalogOutputCoverage()).toBe(false)
  remove()
  expect(f.runtime.supportsCapturedCatalogOutputCoverage()).toBe(false)
})

it('reports retirement only with publication, activation and retirement on the enabled lifecycle', () => {
  const f = setup()
  expect(f.runtime.supportsCapturedSourceRetirement()).toBe(false)
  const removeLegacy = f.runtime.installCapturedPtyDestinationLifecycle({
    ...f.lifecycle,
    supportsCapturedCatalogPublication: () => true,
    inspectPublishedDestinationActivation: vi.fn()
  })
  expect(f.runtime.supportsCapturedCatalogActivation()).toBe(true)
  expect(f.runtime.supportsCapturedSourceRetirement()).toBe(false)
  removeLegacy()
  let available = true
  const remove = f.runtime.installCapturedPtyDestinationLifecycle({
    ...f.lifecycle,
    supportsCapturedCatalogPublication: () => available,
    inspectPublishedDestinationActivation: vi.fn(),
    retirePublishedSourceDelivery: vi.fn()
  })
  expect(f.runtime.supportsCapturedSourceRetirement()).toBe(true)
  expect(f.runtime.supportsCapturedSourceRetirementRecovery()).toBe(false)
  available = false
  expect(f.runtime.supportsCapturedSourceRetirement()).toBe(false)
  available = true
  f.disable()
  expect(f.runtime.supportsCapturedSourceRetirement()).toBe(false)
  remove()
  expect(f.runtime.supportsCapturedSourceRetirement()).toBe(false)
})

it.each(['disabled', 'missing', 'foreign-runtime', 'aborted'] as const)(
  'refuses %s capture before contacting the lifecycle',
  async (failure) => {
    const f = setup()
    if (failure !== 'missing') {
      f.runtime.installCapturedPtyDestinationLifecycle(f.lifecycle)
    }
    if (failure === 'disabled') {
      f.disable()
    }
    const request = {
      ...f.request,
      identity:
        failure === 'foreign-runtime' ? { ...identity, destinationRuntimeId: 'other' } : identity,
      signal: failure === 'aborted' ? AbortSignal.abort() : f.request.signal
    }
    await expect(f.runtime.prepareCapturedPtyDestination(request)).rejects.toThrow()
    expect(f.lifecycle.prepareCapturedDestination).not.toHaveBeenCalled()
  }
)

it.each([false, true])(
  'fences an old disposer when the replacement reuses the lifecycle: %s',
  async (reuse) => {
    const f = setup()
    const uninstall = f.runtime.installCapturedPtyDestinationLifecycle(f.lifecycle)
    expect(() => f.runtime.installCapturedPtyDestinationLifecycle(f.lifecycle)).toThrow(
      'already_installed'
    )
    uninstall()
    await expect(f.runtime.prepareCapturedPtyDestination(f.request)).rejects.toThrow('unavailable')
    const replacement = reuse ? f.lifecycle : { prepareCapturedDestination: vi.fn() }
    f.runtime.installCapturedPtyDestinationLifecycle(replacement)
    uninstall()
    await f.runtime.prepareCapturedPtyDestination(f.request)
    expect(replacement.prepareCapturedDestination).toHaveBeenCalledOnce()
    if (!reuse) {
      expect(f.lifecycle.prepareCapturedDestination).not.toHaveBeenCalled()
    }
  }
)
