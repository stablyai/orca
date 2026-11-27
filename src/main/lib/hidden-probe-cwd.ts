import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isRootLikePath } from '../providers/working-directory/path-safety'

// Folder names predate the generic probe naming; keep them so existing dirs are reused.
const HIDDEN_PROBE_CWD_DIR = 'rate-limit-pty-cwd'
const WSL_HIDDEN_PROBE_CWD_DIR = 'orca-rate-limit-pty-cwd'

// Never let hidden Claude discovery start at a filesystem root; bound cwd to userData or tmpdir (runaway-cpu-hidden-usage-pty-design.md).
function resolveUserDataRoot(userDataPath?: string | null): string {
  const root = userDataPath?.trim() || process.env.ORCA_USER_DATA_PATH?.trim()
  if (root && !isRootLikePath(root)) {
    return root
  }
  return join(tmpdir(), 'orca-rate-limit-pty')
}

export function resolveHiddenProbeCwd(options?: { userDataPath?: string | null }): string {
  const cwd = join(resolveUserDataRoot(options?.userDataPath), HIDDEN_PROBE_CWD_DIR)
  mkdirSync(cwd, { recursive: true })
  const realCwd = realpathSync(cwd)
  if (isRootLikePath(realCwd) || !statSync(realCwd).isDirectory()) {
    throw new Error(`Hidden probe cwd is not a safe directory: ${realCwd}`)
  }
  return realCwd
}

export async function resolveHiddenProbeCwdAsync(options?: {
  userDataPath?: string | null
}): Promise<string> {
  const cwd = join(resolveUserDataRoot(options?.userDataPath), HIDDEN_PROBE_CWD_DIR)
  await mkdir(cwd, { recursive: true })
  const realCwd = await realpath(cwd)
  if (isRootLikePath(realCwd) || !(await stat(realCwd)).isDirectory()) {
    throw new Error(`Hidden probe cwd is not a safe directory: ${realCwd}`)
  }
  return realCwd
}

export function getHiddenProbeWslCwdSetupCommands(): string[] {
  return [
    `orca_rate_limit_cwd="\${TMPDIR:-/tmp}/${WSL_HIDDEN_PROBE_CWD_DIR}"`,
    'mkdir -p "$orca_rate_limit_cwd"',
    'cd "$orca_rate_limit_cwd"'
  ]
}
