import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import { preparePendingRuntimeClose } from '../../../src/renderer/src/components/terminal-pane/pending-runtime-pane-close-test-fixture'

it.each([false, true])(
  'actual close RPC addresses only the captured host incarnation: replacement=%s',
  async (replacement) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the only store method used by the exercised register/resolve/close path.
    const store = { getRepos: () => [] } as unknown as ConstructorParameters<
      typeof OrcaRuntimeService
    >[0]
    const runtime = new OrcaRuntimeService(store)
    const kill = vi.fn((id: string) => {
      runtime.onPtyExit(id, 0)
      return true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real close method uses the supplied kill operation; this fixture launches no subprocess.
    runtime.setPtyController({ kill } as Parameters<typeof runtime.setPtyController>[0])
    const binding = {
      tabId: 'tab-parent',
      leafId: '11111111-1111-4111-8111-111111111111',
      incarnationId: '11111111-1111-4111-8111-111111111111'
    }
    runtime.registerPty('host-pty', 'workspace', null, binding)
    const paneKey = `${binding.tabId}:${binding.leafId}`
    const original = runtime.resolveTerminalPane(paneKey, 'workspace')
    const p = await preparePendingRuntimeClose(`remote:env-1@@${original.handle}`)
    const beforeCall = p.runtimeCall.getMockImplementation()!
    p.runtimeCall.mockImplementation(async (request) => {
      if (request.method !== 'terminal.close') {
        return beforeCall(request)
      }
      const params = request.params
      if (
        !params ||
        typeof params !== 'object' ||
        !('terminal' in params) ||
        typeof params.terminal !== 'string'
      ) {
        throw new Error('expected captured terminal handle')
      }
      return { ok: true, result: { close: await runtime.closeTerminal(params.terminal) } }
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      p.actions.executeClosePane(1)
      if (replacement) {
        runtime.registerPty('host-pty', 'workspace', null, {
          ...binding,
          incarnationId: '22222222-2222-4222-8222-222222222222'
        })
        expect(runtime.resolveTerminalPane(paneKey, 'workspace').handle).not.toBe(original.handle)
      }
      p.acceptCompatibility()
      await p.settle(original.handle)
      expect(p.runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.close', params: { terminal: original.handle } })
      )
      if (replacement) {
        expect(kill).not.toHaveBeenCalled()
        expect(runtime.resolveTerminalPane(paneKey, 'workspace').connected).toBe(true)
      } else {
        expect(kill).toHaveBeenCalledExactlyOnceWith('host-pty')
      }
      expect(window.api.pty.kill).not.toHaveBeenCalled()
    } finally {
      runtime.onPtyExit('host-pty', 0)
    }
  }
)
