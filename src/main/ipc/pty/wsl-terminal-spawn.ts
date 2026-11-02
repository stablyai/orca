import { isWslShellName } from '../../../shared/local-windows-terminal-runtime'
import { parseWslPath } from '../../wsl'

/** A local terminal that runs in WSL: a WSL shell, or a folder under `\\wsl.localhost\…`. */
export function isWslTerminalSpawn(
  shellPath: string | undefined,
  cwd: string | null | undefined
): boolean {
  return isWslShellName(shellPath) || (typeof cwd === 'string' && parseWslPath(cwd) !== null)
}
