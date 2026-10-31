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

/** Discover browsers asynchronously so authorization UI cannot block core RPC readiness. */
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
      supportsGoogleCookieClear: () => provider?.supportsGoogleCookieClear?.() === true,
      headless: true,
      clientHostingWithoutEngine: true,
      isAvailable: engineAvailable
    }
  )
  const ready = Promise.resolve()
    .then(() => resolveOrcadBrowserProvider({ ...options, signal: controller.signal }))
    .then(
      // The factory still serves desktop-hosted pages when no engine provider resolves.
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
        // Resolver errors may include failed cleanup of partially started providers.
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
