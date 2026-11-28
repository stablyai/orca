import type { RuntimeBrowserCommandHost } from '../runtime/browser/commands/browser-command-contracts'
import type { RuntimeBrowserCommands } from '../runtime/browser/commands/browser-commands'
import { setRuntimeBrowserCommandsFactory } from '../runtime/browser/installation/runtime-browser-commands-factory'
import { setBrowserHostClientProfileResolver } from '../runtime/browser-host/profiles/browser-host-client-profile-metadata'
import { browserSessionRegistry } from '../browser/sessions/profiles/browser-session-registry'
import { setManagedBrowserProfileDeleter } from '../runtime/browser-host/profiles/managed-browser-profile-removal'
import { deleteManagedBrowserProfile } from '../browser/sessions/profiles/browser-managed-session-profiles'

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
    throw new TypeError(`Unknown RuntimeBrowserCommands method: ${name}`)
  }
  return member.call(commands, ...args)
}

function createLazyRuntimeBrowserCommands(host: RuntimeBrowserCommandHost): RuntimeBrowserCommands {
  let instancePromise: Promise<RuntimeBrowserCommands> | null = null
  const load = (): Promise<RuntimeBrowserCommands> => {
    if (!instancePromise) {
      instancePromise = import('../runtime/browser/commands/browser-commands')
        .then(({ RuntimeBrowserCommands }) => new RuntimeBrowserCommands(host))
        .catch((error: unknown) => {
          instancePromise = null
          throw error
        })
    }
    return instancePromise
  }

  const target: RuntimeBrowserCommands = Object.create(null)
  return new Proxy(target, {
    has: (_target, property) => typeof property === 'string' && property !== 'then',
    get: (_target, property) => {
      if (property === 'then' || typeof property !== 'string') {
        return undefined
      }
      return async (...args: unknown[]) => callBrowserCommand(await load(), property, args)
    }
  })
}

/** Installs desktop browser command factories while deferring Chromium command/extension modules until first use. */
export function installElectronBrowserCommands(): void {
  setRuntimeBrowserCommandsFactory(createLazyRuntimeBrowserCommands, {
    supportsEngineCapability: () => true,
    clientHosting: true,
    extensions: {
      list: async (params) =>
        (
          await import('../browser/extensions/browser-extension-commands')
        ).desktopBrowserExtensions.list(params),
      reload: async (params) =>
        (
          await import('../browser/extensions/browser-extension-commands')
        ).desktopBrowserExtensions.reload(params)
    }
  })
  setBrowserHostClientProfileResolver((browserProfileId) => {
    const profile = browserSessionRegistry.getProfile(browserProfileId)
    return profile ? { id: profile.id, label: profile.label, scope: profile.scope } : undefined
  })
  setManagedBrowserProfileDeleter(deleteManagedBrowserProfile)
}
