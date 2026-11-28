import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/workspace-layout/layout-owner-switch'
import { formatLayoutOwnerArgument } from '../../shared/workspace-layout/layout-owner-startup'
import { wslHostsWindowArguments } from '../wsl/host-lifecycle/wsl-host-gate'

/** Argv every window on the shared preload needs from birth; the sandboxed renderer can read neither env nor disk. */
export function sharedPreloadWindowArguments(): string[] {
  return [
    formatLayoutOwnerArgument(ORCA_LAYOUT_OWNER_IS_MAIN ? 'main' : 'window'),
    ...wslHostsWindowArguments()
  ]
}
