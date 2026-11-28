import { runProcess } from '@orca/process-host'
import { buildWslExecArgs } from '../../../shared/shell/wsl/wsl-login-shell-command'
import { resolveWslInteropSpawnCwdAsync } from '../execution/wsl-interop-spawn-directory'
import { describeWslProcessFailure } from '../execution/wsl-process-failure'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { parseWslPath } from './unc-path-access'
import { runAsWslUserAct } from './wsl-unc-access-gate'

// wsl.exe exit codes mix host failures with guest results; only these markers prove the guest answered.
const LINKED_MARKER = '__ORCA_LINKED__'
const NAME_TAKEN_MARKER = '__ORCA_NAME_TAKEN__'
// Covers a cold wsl.exe start without letting a wedged one hold the commit open.
const WSL_LINK_TIMEOUT_MS = 30_000
// link() refuses any taken name atomically; -T refuses a folder there instead of linking into it.
// One line: newlines in wsl.exe argv don't survive Windows argument encoding reliably.
const LINK_SCRIPT =
  `if ln -T -- "$1" "$2"; then printf ${LINKED_MARKER}; ` +
  `elif [ -e "$2" ] || [ -L "$2" ]; then printf ${NAME_TAKEN_MARKER}; fi`

/**
 * Hard-links `existingPath` to the new name `newPath` inside the distro, because Windows can't make
 * hard links on WSL's share. False when the two aren't on one distro's share.
 */
export async function tryLinkInsideWslDistro(
  existingPath: string,
  newPath: string
): Promise<boolean> {
  const from = parseWslPath(existingPath)
  const to = parseWslPath(newPath)
  if (!from || !to || from.distro.toLowerCase() !== to.distro.toLowerCase()) {
    return false
  }
  const args = buildWslExecArgs(to.distro, [
    'sh',
    '-c',
    LINK_SCRIPT,
    'sh',
    from.linuxPath,
    to.linuxPath
  ])
  const result = await runAsWslUserAct(to.distro, async () =>
    runProcess({
      program: windowsSystem32Binary('wsl.exe'),
      args,
      env: { ...process.env, WSL_UTF8: '1' },
      cwd: await resolveWslInteropSpawnCwdAsync(),
      timeoutMs: WSL_LINK_TIMEOUT_MS
    })
  )
  const stdout = String(result.stdout)
  if (stdout.includes(LINKED_MARKER)) {
    return true
  }
  if (stdout.includes(NAME_TAKEN_MARKER)) {
    throw Object.assign(new Error(`'${to.linuxPath}' already exists`), { code: 'EEXIST' })
  }
  throw new Error(`Could not create the file inside WSL: ${describeWslProcessFailure(result)}`)
}
