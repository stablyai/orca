import type { RecipeVmOpening, RecipeVmState } from './workspaces/sleep/workspace-sleep-runtime'

/** Desktop main publishes the runtime's single owner of recipe VM wakes (WorkspaceSleepCoordinator)
 *  to the environment transport and RPC; a host without one advertises no wake and wakes nothing. */
export type RecipeVmWaker = {
  /** Where the VM stands; `recordSuspended` is what its stored record says. */
  state: (workspaceId: string, recordSuspended: boolean) => RecipeVmState
  /** A client opened the workspace while its VM is up: a sleep on its way leaves the VM up. */
  noteOpened: (workspaceId: string) => void
  /** Holds a client's open of the workspace until the VM is up, a later Sleep wins, or the hold
   *  runs out. */
  holdOpen: (
    workspaceId: string,
    recordSuspended: boolean,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<RecipeVmOpening>
  /** Holds an open of the workspace behind a saved environment (id or name) for the CLI. */
  openEnvironment: (selector: string) => Promise<RecipeVmOpening>
}

let registered: RecipeVmWaker | null = null

export function registerRecipeVmWaker(waker: RecipeVmWaker | null): void {
  registered = waker
}

export function getRecipeVmWaker(): RecipeVmWaker | null {
  return registered
}
