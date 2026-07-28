import { describe, expect, it, vi } from 'vitest'
import { AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD } from '../shared/agent-hook-relay'
import type { MethodHandler, RequestContext } from './dispatcher'
import { registerManagedHookInstaller, type ManagedHookRuntime } from './managed-hook-installer'

function captureHandler(loadRuntime: () => ManagedHookRuntime): MethodHandler {
  let handler: MethodHandler | undefined
  registerManagedHookInstaller(
    {
      onRequest: (method, nextHandler) => {
        expect(method).toBe(AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD)
        handler = nextHandler
      }
    },
    loadRuntime
  )
  return handler!
}

function context(signal?: AbortSignal): RequestContext {
  return { clientId: 1, isStale: () => signal?.aborted ?? false, signal }
}

describe('registerManagedHookInstaller', () => {
  it('forwards request cancellation to the remote runtime', async () => {
    const controller = new AbortController()
    const installManagedHooks = vi.fn().mockResolvedValue({ installers: 14, errors: 0 })
    const handler = captureHandler(() => ({ installManagedHooks }))

    await expect(handler({}, context(controller.signal))).resolves.toEqual({
      installers: 14,
      errors: 0
    })
    expect(installManagedHooks).toHaveBeenCalledWith({ signal: controller.signal })
  })

  it('does not load or start the runtime for an already-cancelled request', async () => {
    const controller = new AbortController()
    controller.abort()
    const loadRuntime = vi.fn()
    const handler = captureHandler(loadRuntime)

    await expect(handler({}, context(controller.signal))).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(loadRuntime).not.toHaveBeenCalled()
  })

  it('forwards only a valid negotiated server-key fingerprint', async () => {
    const installManagedHooks = vi.fn().mockResolvedValue({ installers: 14, errors: 0 })
    const handler = captureHandler(() => ({ installManagedHooks }))
    const fingerprint = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

    await handler({ hostKeyFingerprint: fingerprint }, context())
    await handler({ hostKeyFingerprint: 'ssh://untrusted-host' }, context())

    expect(installManagedHooks).toHaveBeenNthCalledWith(1, {
      signal: undefined,
      hostKeyFingerprint: fingerprint
    })
    expect(installManagedHooks).toHaveBeenNthCalledWith(2, { signal: undefined })
  })
})
