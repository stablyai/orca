import { readableWslDistroHoldText } from '../../shared/remote-runtime/wsl-hosts/wsl-distro-stopped-hold'
import { parseWslUncPath } from '../../shared/file-access/wsl-paths'

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
  const rest = start === -1 ? '' : message.slice(start + FOLDER_UNAVAILABLE_PREFIX.length)
  // Callers may append lines after the refusal; the path ends at the first one.
  const lineEnd = rest.indexOf('\n')
  const path = (lineEnd === -1 ? rest : rest.slice(0, lineEnd)).trim()
  const distro = parseWslUncPath(path)?.distro
  if (!distro) {
    return message
  }
  const trailing = lineEnd === -1 ? '' : rest.slice(lineEnd)
  return `${message.slice(0, start)}Orca couldn't reach ${path}. The WSL distro ${distro} may be stopped, and Orca doesn't start a stopped distro for this. Start ${distro} (for example, open a terminal in it), then try again.${trailing}`
}
