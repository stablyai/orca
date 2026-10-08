import { BrowserError } from '../browser/browser-error'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../shared/runtime-types'
import type { RuntimeBrowserCommands } from '../runtime/orca-runtime-browser'
import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import {
  resolveOrcadBrowserProvider,
  type OrcadBrowserProvider,
  type OrcadBrowserProviderOptions
} from './orcad-browser-provider'

/** Browser discovery must not hold core RPC readiness hostage to a desktop authorization UI. */
export function startOrcadBrowserProvider(options: OrcadBrowserProviderOptions): {
  ready: Promise<void>
  stop(): Promise<void>
} {
  const controller = new AbortController()
  let provider: OrcadBrowserProvider | null = null
  let startupError: unknown
  let stopping: Promise<void> | undefined
  setRuntimeBrowserCommandsFactory(
    (host) => {
      let commands: RuntimeBrowserCommands | undefined
      // Every member resolves through the getter, so the target needs no members of its own.
      const target: RuntimeBrowserCommands = Object.create(null)
      return new Proxy(target, {
        get: (_target, property) => {
          if (property === 'then' || typeof property !== 'string') {
            return undefined
          }
          return (...args: unknown[]) => {
            if (controller.signal.aborted || !provider?.isAvailable()) {
              throw new BrowserError(
                BROWSER_UNAVAILABLE_ERROR_CODE,
                'Browser automation is unavailable on this host.'
              )
            }
            commands ??= provider.factory(host)
            return callBrowserCommand(commands, property, args)
          }
        }
      })
    },
    { headless: true, isAvailable: () => !controller.signal.aborted && !!provider?.isAvailable() }
  )
  const ready = Promise.resolve()
    .then(() => resolveOrcadBrowserProvider({ ...options, signal: controller.signal }))
    .then(
      (resolved) => {
        provider = resolved
        if (!resolved && !controller.signal.aborted) {
          setRuntimeBrowserCommandsFactory(null)
        }
      },
      (error: unknown) => {
        startupError = error
        if (!controller.signal.aborted) {
          setRuntimeBrowserCommandsFactory(null)
          console.warn('[orcad] Browser startup failed:', error)
        }
      }
    )
  return {
    ready,
    stop: () => {
      controller.abort()
      stopping ??= ready.then(async () => {
        await provider?.stop()
        // Unexpected resolver errors may include failed cleanup of a partially started provider.
        if (startupError) {
          throw startupError
        }
      })
      return stopping
    }
  }
}

type BrowserCommandMember = (this: RuntimeBrowserCommands, ...args: unknown[]) => unknown

function isBrowserCommandMember(value: unknown): value is BrowserCommandMember {
  return typeof value === 'function'
}

/** The proxy forwards by name; anything that is not a command method is refused, not invoked. */
function callBrowserCommand(
  commands: RuntimeBrowserCommands,
  name: string,
  args: unknown[]
): unknown {
  const member: unknown = name in commands ? commands[name] : undefined
  if (!isBrowserCommandMember(member)) {
    throw new BrowserError(BROWSER_UNAVAILABLE_ERROR_CODE, `Unknown browser command: ${name}`)
  }
  return member.call(commands, ...args)
}
