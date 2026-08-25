import { describe, expect, it } from 'vitest'
import { BROWSER_CORE_METHODS } from '../runtime/rpc/methods/browser-core'
import { BROWSER_EXTRA_METHODS } from '../runtime/rpc/methods/browser-extras'
import { BROWSER_SCREENCAST_METHODS } from '../runtime/rpc/methods/browser-screencast'
import { electronSidecarRuntimeMethodName } from './electron-sidecar-method-routing'

/**
 * Why drive the real registry: the Electron provider reaches the sidecar by
 * reversing a string transform, so a browser RPC method whose name is not a
 * mechanical camel-case of its runtime command is silently unreachable — the
 * sidecar answers "unknown method", not "wrong route".
 */
const BROWSER_RPC_METHODS = [
  ...BROWSER_CORE_METHODS,
  ...BROWSER_SCREENCAST_METHODS,
  ...BROWSER_EXTRA_METHODS
]

/**
 * Known-broken today (PR #16193 shipped these mis-routed): the RPC names drop
 * the `Log` suffix that the runtime command carries. Fix the transform and
 * delete the entry — do not add to this list to silence a new mismatch.
 */
const UNROUTABLE_RUNTIME_COMMANDS = new Set(['browserConsoleLog', 'browserNetworkLog'])

/** `browser.screencast.unsubscribe` cleans up a subscription without a browser command. */
const RPC_METHODS_WITHOUT_BROWSER_COMMAND = new Set(['browser.screencast.unsubscribe'])

/** Records the `runtime.browserX` the handler dispatches to, without a live runtime. */
async function runtimeCommandFor(
  method: (typeof BROWSER_RPC_METHODS)[number]
): Promise<string | null> {
  let recorded: string | null = null
  const runtime = new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => {
      if (typeof property === 'string' && recorded === null && property.startsWith('browser')) {
        recorded = property
      }
      return () => ({})
    }
  })
  try {
    await (method.handler as (...args: unknown[]) => Promise<unknown>)(
      { value: '', input: '', text: '', subscriptionId: 'subscription' },
      { runtime },
      () => undefined
    )
  } catch {
    // Handlers that guard on host state still record the property access above.
  }
  return recorded
}

describe('electronSidecarRuntimeMethodName', () => {
  it('round-trips every registered browser RPC method', async () => {
    const mismatches: string[] = []
    const unmapped: string[] = []
    for (const method of BROWSER_RPC_METHODS) {
      const command = await runtimeCommandFor(method)
      if (!command) {
        unmapped.push(method.name)
        continue
      }
      if (UNROUTABLE_RUNTIME_COMMANDS.has(command)) {
        expect(electronSidecarRuntimeMethodName(command)).not.toBe(method.name)
        continue
      }
      const routed = electronSidecarRuntimeMethodName(command)
      if (routed !== method.name) {
        mismatches.push(`${command} routes to ${routed}, sidecar registers ${method.name}`)
      }
    }
    expect(mismatches).toEqual([])
    expect(unmapped).toEqual([...RPC_METHODS_WITHOUT_BROWSER_COMMAND])
  })

  it('covers every registered browser method, so the round-trip cannot pass vacuously', async () => {
    expect(BROWSER_RPC_METHODS.length).toBeGreaterThan(70)
    expect(BROWSER_RPC_METHODS.map((method) => method.name)).toEqual(
      expect.arrayContaining([
        'browser.certificate.proceed',
        'browser.viewport',
        'browser.geolocation',
        'browser.cookie.get',
        'browser.intercept.enable',
        'browser.capture.start',
        'browser.storage.local.set',
        'browser.storage.session.clear'
      ])
    )
  })
})
