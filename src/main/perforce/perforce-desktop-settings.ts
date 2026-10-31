import type { Store } from '../persistence'
import { runWithPerforceSettings } from '../../shared/perforce/p4-settings-context'
import {
  normalizePerforceSettings,
  type PerforceSettings
} from '../../shared/perforce/perforce-settings'

export function desktopPerforceSettings(store: Store): PerforceSettings {
  return normalizePerforceSettings(store.getSettings().perforce)
}

/** Runs `run` with Settings > Perforce applied to every p4 call it makes, here or over SSH. */
export function runWithDesktopPerforceSettings<T>(store: Store, run: () => T): T {
  return runWithPerforceSettings(desktopPerforceSettings(store), run)
}
