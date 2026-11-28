import { resolveCallerLocalPath } from '../../shared/file-access/caller-local-path'
import { getWslCallerDistro } from '../hosts/wsl-caller-distro'

/** A file path flag the caller typed, resolved as its shell would: a WSL shell's Linux path names a distro file. */
export function resolveCallerFilePath(path: string, cwd: string): string {
  return resolveCallerLocalPath(path, cwd, getWslCallerDistro(cwd))
}
