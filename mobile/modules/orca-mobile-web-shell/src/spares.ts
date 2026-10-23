import { requireOptionalNativeModule } from 'expo-modules-core'

/**
 * A page booted ahead of the screen that shows it, one app-wide. The id given to `prepareSpare` is
 * the session id the view must be rendered with; `takeSpare` hands it out once.
 */
export type OrcaMobileWebShellSparesModule = {
  prepareSpare: (hostKey: string, generationDirectory: string, sessionId: string) => Promise<void>
  /** The spare's session id when it was booted from this directory and is alive; null otherwise. */
  takeSpare: (hostKey: string, generationDirectory: string) => Promise<string | null>
  /** Null for every host. */
  discardSpares: (hostKey: string | null) => Promise<void>
}

const shellModule =
  requireOptionalNativeModule<Partial<OrcaMobileWebShellSparesModule>>('OrcaMobileWebShell')

// Bound rather than detached: a native function may read its receiver.
function sparesOf(
  module: Partial<OrcaMobileWebShellSparesModule> | null
): OrcaMobileWebShellSparesModule | null {
  const prepareSpare = module?.prepareSpare
  const takeSpare = module?.takeSpare
  const discardSpares = module?.discardSpares
  if (prepareSpare === undefined || takeSpare === undefined || discardSpares === undefined) {
    return null
  }
  return {
    prepareSpare: prepareSpare.bind(module),
    takeSpare: takeSpare.bind(module),
    discardSpares: discardSpares.bind(module)
  }
}

/** Null in a binary built before spares existed. */
export const OrcaMobileWebShellSpares = sparesOf(shellModule)
