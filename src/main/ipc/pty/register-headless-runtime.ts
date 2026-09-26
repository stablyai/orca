import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { Store } from '../../persistence'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type {
  CodexHomePtySpawnedLifecycleArgs,
  GetSelectedCodexHomePath,
  PrepareClaudeAuth,
  PrepareCodexSessionResume
} from './host-env/types'
import { registerPtyHandlers } from './register-handlers'
import { hydrateLocalPtyRegistryAtBoot } from '../../memory/hydrate-local-pty-registry'

export function registerHeadlessPtyRuntime(
  runtime: OrcaRuntimeService,
  getSelectedCodexHomePath?: GetSelectedCodexHomePath,
  getSettings?: () => GlobalSettings,
  prepareClaudeAuth?: PrepareClaudeAuth,
  store?: Store,
  prepareCodexSessionResume?: PrepareCodexSessionResume,
  lifecycle?: {
    onCodexHomePtySpawned?: (args: CodexHomePtySpawnedLifecycleArgs) => void
    onPtyExit?: (id: string, exitSequence: number) => void
  }
): Promise<void> {
  registerPtyHandlers(
    undefined,
    runtime,
    getSelectedCodexHomePath,
    getSettings,
    prepareClaudeAuth,
    store,
    { prepareCodexSessionResume, ...lifecycle }
  )
  return store ? hydrateLocalPtyRegistryAtBoot(store) : Promise.resolve()
}
