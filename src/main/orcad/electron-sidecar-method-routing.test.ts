import { describe, expect, it } from 'vitest'
import { BROWSER_CORE_METHODS } from '../runtime/rpc/methods/browser-core'
import { BROWSER_EXTRA_METHODS } from '../runtime/rpc/methods/browser-extras'
import { BROWSER_SCREENCAST_METHODS } from '../runtime/rpc/methods/browser-screencast'
import { electronSidecarRuntimeMethodName } from './electron-sidecar-method-routing'

// Exercise real RPC registration: names that diverge from runtime camel-casing can become unreachable.
const BROWSER_RPC_METHODS = [
  ...BROWSER_CORE_METHODS,
  ...BROWSER_SCREENCAST_METHODS,
  ...BROWSER_EXTRA_METHODS
]

// Known Log-suffix mismatches: remove entries when fixed; never add entries to hide new failures.
const UNROUTABLE_RUNTIME_COMMANDS = new Set(['browserConsoleLog', 'browserNetworkLog'])

const RPC_METHODS_WITHOUT_BROWSER_COMMAND = new Set(['browser.screencast.unsubscribe'])

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
})
