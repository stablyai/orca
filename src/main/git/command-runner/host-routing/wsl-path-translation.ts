import type { GitExecutionContext } from './wsl-git-path-preparation'
import { toWindowsWslUncPath } from '../../../../shared/wsl-paths'
import { parseWslPath } from '../../../wsl/filesystem/unc-path-access'
import {
  type WslAutomountSnapshot,
  settleWslAutomountSnapshot,
  peekWslAutomountRoot
} from '../../../wsl/filesystem/wsl-automount-root'
import {
  windowsDrivePathForDistro,
  wslDrivePathForDistro
} from '../../../wsl/filesystem/wsl-drive-paths'

/** Windows operands use the selected distro's filesystem namespace. */
export function translateArgsForWsl(
  args: string[],
  distro: string,
  snapshot?: WslAutomountSnapshot
): string[] {
  return args.map((arg) => translateArgForWsl(arg, distro, snapshot))
}

export function translateArgForWsl(
  arg: string,
  distro: string,
  snapshot?: WslAutomountSnapshot
): string {
  const wslInfo = parseWslPath(arg)
  if (wslInfo) {
    return wslInfo.linuxPath
  }

  return wslDrivePathForDistro(arg, distro, snapshot) ?? arg
}

/** Map Linux worktree output to UNC paths Node can open on Windows. */
export function translateWslOutputPaths(
  output: string,
  originalCwd: string,
  options: { wslDistro?: string; executionContext?: GitExecutionContext } = {}
): string {
  return output.replace(/(?<=worktree )(\/.+)$/gm, (_match, path: string) =>
    translateWslOutputPath(path, originalCwd, options)
  )
}

function translateWslOutputPath(
  path: string,
  originalCwd: string,
  options: { wslDistro?: string; executionContext?: GitExecutionContext }
): string {
  const wsl = parseWslPath(originalCwd)
  const context = options.executionContext
  if (context?.kind === 'host' || !path.startsWith('/')) {
    return path
  }
  const snapshot = context?.kind === 'wsl' ? context.paths : undefined
  const distro = snapshot?.distro ?? wsl?.distro ?? options.wslDistro
  if (!distro) {
    return path
  }

  // A drive-folder repo saved as UNC keeps that namespace for its worktree identities.
  if (
    wsl &&
    ((snapshot ? snapshot.root : peekWslAutomountRoot(distro)) === null ||
      windowsDrivePathForDistro(wsl.linuxPath, distro, snapshot))
  ) {
    return toWindowsWslUncPath(path, distro)
  }
  return windowsDrivePathForDistro(path, distro, snapshot) ?? toWindowsWslUncPath(path, distro)
}

/** Resolve identity from the command that produced these bytes, before later disk/setup awaits. */
export async function gitResultPathTranslator(
  result: { executionContext?: GitExecutionContext },
  cwd: string,
  options: { wslDistro?: string; signal?: AbortSignal } = {}
): Promise<((path: string) => string) & { executionContext?: GitExecutionContext }> {
  const original = result.executionContext
  const context =
    original?.kind === 'wsl'
      ? {
          kind: 'wsl' as const,
          paths: await settleWslAutomountSnapshot(original.paths, options.signal)
        }
      : original
  const toHostPath = (path: string): string =>
    translateWslOutputPath(path, cwd, {
      ...options,
      executionContext: context
    })
  return Object.assign(toHostPath, { executionContext: context })
}
