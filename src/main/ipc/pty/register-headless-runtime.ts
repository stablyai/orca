import type { BrowserWindow } from 'electron'
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
): void {
  // Why: headless `orca serve` has no renderer window but still needs the same PTY handlers so remote clients can drive terminals.
  // Why a fake rather than null: `registerPtyHandlers` takes a non-null BrowserWindow. `isDestroyed: () => true`
  // is what makes that safe — every renderer-liveness guard reads it and skips, so no send is ever attempted.
  // Keep `webContents.isDestroyed` in step with it: guards check both, and a missing method reads as "alive".
  const headlessWindow = {
    isDestroyed: () => true,
    webContents: {
      isDestroyed: () => true,
      send: () => {},
      on: () => {},
      removeListener: () => {}
    }
  } as unknown as BrowserWindow
  registerPtyHandlers(
    headlessWindow,
    runtime,
    getSelectedCodexHomePath,
    getSettings,
    prepareClaudeAuth,
    store,
    { prepareCodexSessionResume, ...lifecycle }
  )
}
