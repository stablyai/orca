import { randomInt } from 'node:crypto'
import type { PersistedState } from '../../../../shared/persisted-state-types'
import type { FirstLaunchLayout } from '../../../../shared/telemetry-settings-types'
import { isOfficialTelemetryBuild } from '../../../telemetry/official-build'
import { createInitialHomeWorkspaceState } from './initial-home-workspace'

const LAYOUT_OVERRIDE_ENV = 'ORCA_FIRST_LAUNCH_LAYOUT'

/** Single switch for fresh desktop profiles; returning undefined keeps everyone on the `~` workspace. */
export function chooseFirstLaunchLayout(): FirstLaunchLayout | undefined {
  return randomInt(2) === 0 ? 'home-workspace' : 'project-picker'
}

/** Release builds choose; other builds start in `~` unless tests or QA pin a layout. */
export function resolveFirstLaunchLayout(
  official = isOfficialTelemetryBuild(),
  env: NodeJS.ProcessEnv = process.env
): FirstLaunchLayout | undefined {
  if (official) {
    return chooseFirstLaunchLayout()
  }
  const pinned = env[LAYOUT_OVERRIDE_ENV]
  return pinned === 'home-workspace' || pinned === 'project-picker' ? pinned : undefined
}

/** Builds a missing desktop profile's first state; the layout is saved with it so restarts never choose again. */
export function createFirstLaunchState(
  state: PersistedState,
  layout: FirstLaunchLayout | undefined = resolveFirstLaunchLayout()
): PersistedState {
  const telemetry = state.settings?.telemetry
  const withLayout =
    layout && telemetry
      ? {
          ...state,
          settings: {
            ...state.settings,
            telemetry: { ...telemetry, firstLaunchLayout: layout }
          }
        }
      : state
  return layout === 'project-picker' ? withLayout : createInitialHomeWorkspaceState(withLayout)
}
