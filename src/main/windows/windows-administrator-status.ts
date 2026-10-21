import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { getAppEnvironment } from '../../shared/app-environment'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'

let status: Promise<boolean | null> | undefined

export function getWindowsAdministratorStatus(): Promise<boolean | null> {
  if (process.platform !== 'win32') {
    return Promise.resolve(null)
  }
  // The desktop's token does not change during its lifetime; never poll or prompt for elevation.
  return (status ??= readStatus().catch(() => null))
}

async function readStatus(): Promise<boolean | null> {
  const environment = getAppEnvironment()
  const launcher = environment.isPackaged()
    ? getBundledLauncherPath('win32', process.resourcesPath)
    : join(environment.getAppPath(), 'native', 'windows-cli-launcher', '.build', 'orca.exe')
  if (!launcher) {
    return null
  }
  const result = await runProcess({
    program: launcher,
    args: ['--orca-administrator-status'],
    timeoutMs: 3_000,
    maxOutputBytes: 64
  })
  if (result.code !== 0 || result.timedOut) {
    return null
  }
  const answer = result.stdout.trim()
  return answer === 'true' ? true : answer === 'false' ? false : null
}
