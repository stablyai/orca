/** What a chat refused in a Windows-opened WSL folder can do instead: run it on a WSL host. */

import { parseWslUncPath } from '../../shared/file-access/wsl-paths'
import { wslHostsAcceptNewWork } from '../wsl/host-lifecycle/wsl-host-gate'

export type WslHostChatRecovery = {
  /** The distro the workspace lives in, when its path names one. */
  wslDistro?: string
  nextSteps: string[]
}

/** Null while this launch can't add WSL hosts, where pointing at them would be a dead end. */
export function wslHostChatRecovery(
  workspacePath: string | undefined,
  acceptsNewWork: () => boolean = wslHostsAcceptNewWork
): WslHostChatRecovery | null {
  if (!acceptsNewWork()) {
    return null
  }
  const distro = workspacePath ? parseWslUncPath(workspacePath)?.distro : undefined
  const distroName = distro ?? 'the distro'
  const moveItem = distro ? `“Move to ${distro} host…”` : '“Move to <distro> host…”'
  return {
    ...(distro ? { wslDistro: distro } : {}),
    nextSteps: [
      `Chat works when the project runs on a WSL host. In Orca, turn on Settings → Experimental → WSL hosts, add ${distroName} as a host (Add a project → Add remote host → Add WSL distro), then choose ${moveItem} on the project in the sidebar and launch the chat there.`,
      'Or run the same command with --surface terminal to start the agent in a terminal.'
    ]
  }
}
