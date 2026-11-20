import { Socket } from 'node:net'
import { app } from 'electron'
import { spawnProcess } from '@orca/process-host'
import { appImageEphemeralRootOf } from '../../../shared/desktop-distribution/appimage/appimage-ephemeral-root'
import { envWithoutAppImageRuntime } from '../../pty/shell-startup/appimage-terminal-env'
import { resolveAppImageRelaunchPath } from '../../updater/linux-package/appimage-runtime-identity'
import { runWithLaunchPath } from '../shell-environment/hydrate-shell-path'

// Wait for the old process and, in extract-and-run mode, its parent to finish cleaning up.
const RELAUNCH_SCRIPT = `
# Close inherited Chromium sockets and the AppImage's FUSE keepalive fd.
for fd in /proc/self/fd/[0-9]*; do
  fd=\${fd##*/}
  if (( fd > 2 )); then exec {fd}>&-; fi
done
electron=/proc/$1/exe
runtime=/proc/$2/exe
shift 2
[ "$runtime" -ef "$1" ] || runtime=
while IFS= read -r line; do :; done
while [ -e "$electron" ] || { [ -n "$runtime" ] && [ -e "$runtime" ]; }; do /bin/sleep 0.1; done
exec "$@"
`

let appImageRelaunchScheduled = false

export async function scheduleAppRelaunch(options?: Electron.RelaunchOptions): Promise<void> {
  const appImagePath =
    app.isPackaged && options?.execPath === undefined ? await resolveAppImageRelaunchPath() : null
  runWithLaunchPath(() => {
    if (appImagePath) {
      appImageRelaunchScheduled ||= scheduleAppImageRelaunch(
        appImagePath,
        options?.args ?? process.argv.slice(1)
      )
      if (appImageRelaunchScheduled) {
        return
      }
    }
    app.relaunch(options)
  })
}

function scheduleAppImageRelaunch(appImagePath: string, args: string[]): boolean {
  const env = envWithoutAppImageRuntime(process.env)
  delete env.TARGET_APPIMAGE
  // The AppImage runtime consumes --appimage-extract-and-run before starting Electron.
  if (appImageEphemeralRootOf(process.execPath)?.kind === 'extract') {
    env.APPIMAGE_EXTRACT_AND_RUN = '1'
  }
  try {
    // Electron's Linux relauncher sets NO_NEW_PRIVS, which blocks setuid fusermount.
    const child = spawnProcess({
      program: 'bash',
      args: [
        '-pc',
        RELAUNCH_SCRIPT,
        'orca-appimage-relaunch',
        String(process.pid),
        String(process.ppid),
        appImagePath,
        ...args
      ],
      env,
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore']
    })
    child.on('error', (error) => console.warn('[app] AppImage relaunch failed:', error.name))
    if (child.stdin instanceof Socket) {
      child.stdin.unref()
    }
    child.unref()
    return child.pid !== undefined
  } catch (error) {
    console.warn(
      '[app] AppImage relaunch failed:',
      error instanceof Error ? error.name : typeof error
    )
    return false
  }
}
