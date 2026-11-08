import { readableWslDistroHoldText } from '../shared/wsl-distro-stopped-hold'
import { parseWslUncPath } from '../shared/wsl-paths'

const FOLDER_UNAVAILABLE_PREFIX = 'folder_workspace_path_unavailable:'

/**
 * A refusal over a WSL distro, named: older servers send the raw hold code, and a folder on a
 * distro Orca won't start in the background reads only as "path unavailable".
 */
export function readableWslDistroCliRefusal(message: string): string {
  const held = readableWslDistroHoldText(message)
  if (held !== message) {
    return held
  }
  const start = message.indexOf(FOLDER_UNAVAILABLE_PREFIX)
  const path = start === -1 ? '' : message.slice(start + FOLDER_UNAVAILABLE_PREFIX.length).trim()
  const distro = parseWslUncPath(path)?.distro
  if (!distro) {
    return message
  }
  return `${message.slice(0, start)}Orca couldn't reach ${path}. The WSL distro ${distro} may be stopped, and Orca doesn't start a stopped distro for this. Start ${distro} (for example, open a terminal in it), then try again.`
}
