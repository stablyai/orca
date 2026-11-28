// Which of the host's terminals give agy another login than the host's own (another home,
// credential store or session bus), by the environment each spawned with. Saved accounts never
// name such a login, so a switch neither moves nor restarts agy there.

import { agyLaunchIsForeign } from './agy-launch-credential-authority'

// One entry per pane spawned this session (a restart replaces its own), so it stays small.
const foreignByPaneKey = new Map<string, Promise<boolean>>()

/** A host terminal spawned for `paneKey` with `env`; a later spawn there replaces the answer. */
export function noteAgyTerminalAuthority(
  paneKey: string,
  env: NodeJS.ProcessEnv,
  envToDelete: readonly string[] = []
): void {
  foreignByPaneKey.set(
    paneKey,
    agyLaunchIsForeign(env, { envToDelete }).catch(() => false)
  )
}

/** Whether agy in this pane's terminal reads another login than the host's own; false when its
 *  spawn wasn't seen (it then inherited the host's environment). */
export function agyTerminalIsForeign(paneKey: string): Promise<boolean> {
  return foreignByPaneKey.get(paneKey) ?? Promise.resolve(false)
}
