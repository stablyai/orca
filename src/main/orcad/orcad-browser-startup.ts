import { BrowserError } from '../browser/browser-error'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../shared/runtime-types'
import type { RuntimeBrowserCommands } from '../runtime/browser/browser-commands'
import {
  browserUnavailableError,
  setRuntimeBrowserCommandsFactory
} from '../runtime/runtime-browser-commands-factory'
import {
  resolveOrcadBrowserProvider,
  type OrcadBrowserProvider,
  type OrcadBrowserProviderOptions
} from './orcad-browser-provider'
import { orcadClientPageCommand } from './orcad-client-page-commands'

/** Browser discovery must not hold core RPC readiness hostage to a desktop authorization UI. */
export function startOrcadBrowserProvider(options: OrcadBrowserProviderOptions): {
  ready: Promise<void>
  stop(): Promise<void>
} {
  const controller = new AbortController()
  let provider: OrcadBrowserProvider | null = null
  let startupError: unknown
  let stopping: Promise<void> | undefined
  const engineAvailable = (): boolean => !controller.signal.aborted && !!provider?.isAvailable()
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
          const forward = (args: unknown[], name: string = property): unknown => {
            if (!engineAvailable() || !provider) {
              throw browserUnavailableError()
            }
            commands ??= provider.factory(host)
            return callBrowserCommand(commands, name, args)
          }
          return (
            orcadClientPageCommand(host, property, forward, engineAvailable) ??
            ((...args: unknown[]) => forward(args))
          )
        }
      })
    },
    {
      headless: true,
      clientHostingWithoutEngine: true,
      isAvailable: engineAvailable
    }
  )
  const ready = Promise.resolve()
    .then(() => resolveOrcadBrowserProvider({ ...options, signal: controller.signal }))
    .then(
      // Why the factory stays installed without a provider: it still serves desktop-hosted pages.
      (resolved) => {
        provider = resolved
      },
      (error: unknown) => {
        startupError = error
        if (!controller.signal.aborted) {
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
