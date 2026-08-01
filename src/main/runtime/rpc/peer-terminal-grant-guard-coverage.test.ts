// Why: regression for the terminal.split/show/inspectProcess/resizeForClient/restoreFit/
// getDisplayMode gap — every TERMINAL_METHODS entry whose params accept a `terminal` handle
// must reject an ungranted handle for a peer device, so a future addition can't silently skip it.
import { describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

const UNGRANTED_TERMINAL = 'ungranted-terminal'

// Why: methods proven above to accept a `terminal` handle and act on that specific terminal
// (excludes worktree-scoped methods like terminal.stop/sleep/create and the binary-stream
// terminal.multiplex, which resolve terminals per-frame after the initial subscribe).
const GUARDED_TERMINAL_METHOD_PARAMS: Record<string, Record<string, unknown>> = {
  'terminal.show': { terminal: UNGRANTED_TERMINAL },
  'terminal.read': { terminal: UNGRANTED_TERMINAL },
  'terminal.inspectProcess': { terminal: UNGRANTED_TERMINAL },
  'terminal.isRunningAgent': { terminal: UNGRANTED_TERMINAL },
  'terminal.agentStatus': { terminal: UNGRANTED_TERMINAL },
  'terminal.rename': { terminal: UNGRANTED_TERMINAL, title: 'x' },
  'terminal.clearBuffer': { terminal: UNGRANTED_TERMINAL },
  'terminal.send': { terminal: UNGRANTED_TERMINAL, text: 'x' },
  'terminal.wait': { terminal: UNGRANTED_TERMINAL, for: 'exit' },
  'terminal.split': { terminal: UNGRANTED_TERMINAL },
  'terminal.resizeForClient': {
    terminal: UNGRANTED_TERMINAL,
    mode: 'restore',
    clientId: 'client-1'
  },
  'terminal.focus': { terminal: UNGRANTED_TERMINAL },
  'terminal.close': { terminal: UNGRANTED_TERMINAL },
  'terminal.closeTab': { terminal: UNGRANTED_TERMINAL },
  'terminal.setDisplayMode': { terminal: UNGRANTED_TERMINAL, mode: 'auto' },
  'terminal.restoreFit': { terminal: UNGRANTED_TERMINAL },
  'terminal.getDisplayMode': { terminal: UNGRANTED_TERMINAL },
  'terminal.listSubscribers': { terminal: UNGRANTED_TERMINAL },
  'terminal.updateViewport': {
    terminal: UNGRANTED_TERMINAL,
    client: { id: 'client-1' },
    viewport: { cols: 80, rows: 24 }
  },
  'terminal.subscribe': { terminal: UNGRANTED_TERMINAL }
}

function stubRuntime(): OrcaRuntimeService {
  // Why: assertPeerTerminalGranted must throw before any other runtime method is touched.
  return new Proxy(
    { getRuntimeId: () => 'test-runtime' },
    {
      get(target, prop, receiver) {
        if (prop === 'getRuntimeId') {
          return Reflect.get(target, prop, receiver)
        }
        throw new Error('runtime should not be reached for an ungranted terminal')
      }
    }
  ) as OrcaRuntimeService
}

describe('peer terminal grant guard coverage', () => {
  const dispatcher = new RpcDispatcher({ runtime: stubRuntime(), methods: TERMINAL_METHODS })

  it('every TERMINAL_METHODS entry that accepts a terminal handle is guarded', () => {
    const declaredMethods = new Set(TERMINAL_METHODS.map((m) => m.name))
    for (const methodName of Object.keys(GUARDED_TERMINAL_METHOD_PARAMS)) {
      expect(declaredMethods.has(methodName)).toBe(true)
    }
    // Why: the reverse direction — a new method whose schema declares a
    // `terminal` param must land in the guarded map (or be excluded here with
    // a reason), otherwise this suite silently stops covering it.
    for (const method of TERMINAL_METHODS) {
      const shape = (method.params as { shape?: Record<string, unknown> }).shape
      if (!shape || !('terminal' in shape)) {
        continue
      }
      expect(
        method.name in GUARDED_TERMINAL_METHOD_PARAMS,
        `${method.name} declares a terminal param but is not covered by this suite`
      ).toBe(true)
    }
  })

  for (const [method, params] of Object.entries(GUARDED_TERMINAL_METHOD_PARAMS)) {
    it(`rejects a peer device acting on an ungranted terminal via ${method}`, async () => {
      const request: RpcRequest = {
        id: 'req-1',
        authToken: 'tok',
        method,
        params
      }
      const responses: string[] = []
      await dispatcher.dispatchStreaming(request, (response) => responses.push(response), {
        isPeerDevice: true,
        getGrantedTerminals: () => []
      })
      const [response] = responses
      expect(response, `expected ${method} to reply exactly once`).toBeDefined()
      const parsed = JSON.parse(response as string) as { ok: boolean; error?: { message: string } }
      expect(parsed.ok).toBe(false)
      expect(parsed.error?.message).toBe('peer_terminal_not_granted')
    })
  }
})
