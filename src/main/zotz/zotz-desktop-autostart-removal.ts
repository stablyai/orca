import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import type { ZotzAutostartRemovalResult } from '../../shared/zotz/zotz-node-setup-contract'
import {
  renderZotzDesktopAutostart,
  ZOTZ_SERVER_SYSTEMD_UNIT,
  ZOTZ_SERVER_TASK_PATH
} from './zotz-desktop-autostart'
import type { ZotzNodeSetupEnvironment } from './zotz-node-setup-environment'
import { processOutput } from './zotz-process-runner'
import { runElevatedWindowsProcess } from './zotz-windows-elevation'

/** Leaving server mode stops the OS from relaunching Zotz; system tweaks are undone by hand. */
export async function removeZotzDesktopAutostart(
  environment: ZotzNodeSetupEnvironment
): Promise<ZotzAutostartRemovalResult> {
  const spec = renderZotzDesktopAutostart({
    platform: environment.platform,
    executablePath: environment.executablePath,
    homeDir: environment.homeDir,
    userDataPath: environment.userDataPath,
    windowsUserId: environment.username
  })
  if (!spec) {
    return { ok: true, removed: false, detail: 'nothing to remove' }
  }
  if (environment.platform === 'win32') {
    const schtasks = windowsSystem32Binary('schtasks.exe', environment.env)
    const args = ['/Delete', '/TN', ZOTZ_SERVER_TASK_PATH, '/F']
    const query = await environment.run(schtasks, ['/Query', '/TN', ZOTZ_SERVER_TASK_PATH])
    if (query.code !== 0) {
      await environment.removeFile(spec.path)
      return { ok: true, removed: false, detail: 'not installed' }
    }
    const direct = await environment.run(schtasks, args)
    // The task was registered elevated, so a standard account usually needs the prompt to delete it.
    const outcome =
      direct.code === 0
        ? { ok: true }
        : await runElevatedWindowsProcess(
            environment.run,
            environment.env,
            schtasks,
            args,
            5 * 60_000
          )
    const ok = 'ok' in outcome ? outcome.ok : outcome.launched && outcome.exitCode === 0
    if (ok) {
      await environment.removeFile(spec.path)
    }
    return { ok, removed: ok, detail: ok ? ZOTZ_SERVER_TASK_PATH : processOutput(direct) }
  }
  if (!(await environment.exists(spec.path))) {
    return { ok: true, removed: false, detail: 'not installed' }
  }
  if (environment.platform === 'linux') {
    await environment.run('systemctl', ['--user', 'disable', ZOTZ_SERVER_SYSTEMD_UNIT])
  }
  await environment.removeFile(spec.path)
  if (environment.platform === 'linux') {
    await environment.run('systemctl', ['--user', 'daemon-reload'])
  }
  return { ok: true, removed: true, detail: spec.path }
}
