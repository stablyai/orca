import type { DnrEngine } from '../engine'
import type { DnrExtensionRules } from './browser-extension-dnr-extension-rules'

export type DnrRuntimeModules = {
  DnrEngine: typeof DnrEngine
  DnrExtensionRules: typeof DnrExtensionRules
}

let pendingModules: Promise<DnrRuntimeModules> | null = null

export function loadDnrRuntimeModules(): Promise<DnrRuntimeModules> {
  pendingModules ??= Promise.all([
    import('../engine'),
    import('./browser-extension-dnr-extension-rules')
  ]).then(
    ([{ DnrEngine }, { DnrExtensionRules }]) => ({ DnrEngine, DnrExtensionRules }),
    (error: unknown) => {
      pendingModules = null
      throw error
    }
  )
  return pendingModules
}
