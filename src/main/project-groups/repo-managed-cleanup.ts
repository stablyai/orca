import { rm } from 'node:fs/promises'
import { runProcess } from '../../shared/child-process/run-process'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { parseWslPath } from '../wsl'

export async function removeDerivedRepoPath(path: string): Promise<void> {
  const wsl = parseWslPath(path)
  if (!wsl) {
    await rm(path, { recursive: true, force: true })
    return
  }
  await runProcess({
    program: 'wsl.exe',
    args: buildWslExecArgs(wsl.distro, ['/bin/rm', '-rf', '--', wsl.linuxPath]),
    timeoutMs: 120_000
  })
}
