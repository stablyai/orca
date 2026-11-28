// Which of the host's terminals give agy another login than the host's own (another home,
// credential store or session bus), by the environment each spawned with. Saved accounts never
// name such a login, so a switch neither moves nor restarts agy there.

import { agyLaunchIsForeign } from './agy-launch-credential-authority'

type PaneAuthority = {
  foreign: Promise<boolean>
  /** The terminal this spawn became; unset until it registers. */
  terminal?: string
}

// One entry per live pane: a spawn replaces its pane's entry, and its terminal's exit removes it.
const authorityByPaneKey = new Map<string, PaneAuthority>()
const paneKeyByPtyId = new Map<string, string>()

/** A host terminal is spawning for `paneKey` with `env`; it replaces the pane's earlier answer. */
export function noteAgyTerminalAuthority(
  paneKey: string,
  env: NodeJS.ProcessEnv,
  envToDelete: readonly string[] = []
): void {
  authorityByPaneKey.set(paneKey, {
    foreign: agyLaunchIsForeign(env, { envToDelete }).catch(() => false)
  })
}

/** The terminal a pane's latest spawn became. */
export function bindAgyTerminalAuthority(paneKey: string, ptyId: string): void {
  const authority = authorityByPaneKey.get(paneKey)
  if (authority && authority.terminal === undefined) {
    authority.terminal = ptyId
    paneKeyByPtyId.set(ptyId, paneKey)
  }
}

/** A terminal exited: its pane's answer goes, unless a newer spawn there replaced it already. */
export function forgetAgyTerminalAuthority(ptyId: string): void {
  const paneKey = paneKeyByPtyId.get(ptyId)
  if (paneKey === undefined) {
    return
  }
  paneKeyByPtyId.delete(ptyId)
  if (authorityByPaneKey.get(paneKey)?.terminal === ptyId) {
    authorityByPaneKey.delete(paneKey)
  }
}

/** Whether agy in this pane's terminal reads another login than the host's own; false when its
 *  spawn wasn't seen (it then inherited the host's environment). */
export function agyTerminalIsForeign(paneKey: string): Promise<boolean> {
  return authorityByPaneKey.get(paneKey)?.foreign ?? Promise.resolve(false)
}
