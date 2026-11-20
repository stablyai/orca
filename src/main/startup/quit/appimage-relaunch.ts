import { writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { app } from 'electron'
import { spawnProcess } from '@orca/process-host'
import { appImageEphemeralRootOf } from '../../../shared/desktop-distribution/appimage/appimage-ephemeral-root'
import { envWithoutAppImageRuntime } from '../../pty/shell-startup/appimage-terminal-env'
import { resolveAppImageRelaunchPath } from '../../updater/linux-package/appimage-runtime-identity'
import { runWithLaunchPath } from '../shell-environment/hydrate-shell-path'
import { settleWithinMs } from './quit-teardown-deadline'

const APP_RUN_DATA_DIRS = ':/usr/share/gnome:/usr/local/share/:/usr/share/'
const RELAUNCH_CHECK_TIMEOUT_MS = 5_000

const RELAUNCH_SCRIPT = `
# Close inherited Chromium sockets and the AppImage's FUSE keepalive fd.
for fd in /proc/self/fd/[0-9]*; do
  fd=\${fd##*/}
  if (( fd > 2 )); then exec {fd}>&-; fi
done
electron=/proc/$1/exe
runtime=/proc/$2/exe
failure_log=$3
shift 3
[ "$runtime" -ef "$1" ] || runtime=
sleep_path=$(type -P sleep)
if [ ! -x "$sleep_path" ] || ! "$sleep_path" 0.0; then printf 'sleep unavailable\\n'; exit 1; fi
if [ ! -f "$1" ] || [ ! -x "$1" ]; then printf 'AppImage unavailable\\n'; exit 1; fi
printf 'ready\\n' || exit 1
IFS= read -r request && [ "$request" = restart ] || exit 0
exec </dev/null >/dev/null
report_failure() {
  printf '%s\\n' "$1" > "$failure_log"
  exit 1
}
set -o noclobber
umask 077
# The extract-and-run parent may still be cleaning up after Electron exits.
deadline=$(( SECONDS + 60 ))
while [ -e "$electron" ] || { [ -n "$runtime" ] && [ -e "$runtime" ]; }; do
  if (( SECONDS >= deadline )); then report_failure 'Timed out waiting for the old Orca process.'; fi
  "$sleep_path" 0.1 || report_failure 'Could not wait for the old Orca process.'
done
# The file can still be moved or replaced between this check and exec.
if [ ! -f "$1" ] || [ ! -x "$1" ]; then
  report_failure 'The AppImage was moved, deleted or made nonexecutable during restart.'
fi
shopt -s execfail
exec "$@"
report_failure 'Could not execute the AppImage after Orca exited.'
`

async function resolveRestartArtifact(): Promise<string | null> {
  const result = await settleWithinMs(resolveAppImageRelaunchPath(), RELAUNCH_CHECK_TIMEOUT_MS)
  if (result.outcome === 'timed-out') {
    throw new Error('Timed out checking the original AppImage.')
  }
  if (result.outcome === 'failed') {
    throw result.error
  }
  return result.value
}

export type PreparedAppRelaunch = {
  commit(): Promise<void>
  cancel(): void
  reportFailure(error: unknown): Promise<void>
}

export async function prepareAppImageRelaunch(
  args: string[],
  signal: AbortSignal
): Promise<PreparedAppRelaunch> {
  const appImagePath = await resolveRestartArtifact()
  signal.throwIfAborted()
  if (!appImagePath) {
    throw new Error('Orca could not restart because the original AppImage is missing or invalid.')
  }

  const failureLog = join(
    app.getPath('userData'),
    `appimage-restart-${process.pid}-${Date.now()}.log`
  )
  const child = runWithLaunchPath(() => {
    const env = envWithoutAppImageRuntime(process.env)
    delete env.TARGET_APPIMAGE
    // AppRun appends these defaults on every launch. Preserve the host entries in their original order.
    while (env.XDG_DATA_DIRS?.endsWith(APP_RUN_DATA_DIRS)) {
      env.XDG_DATA_DIRS = env.XDG_DATA_DIRS.slice(0, -APP_RUN_DATA_DIRS.length)
    }
    if (!env.XDG_DATA_DIRS || env.XDG_DATA_DIRS === APP_RUN_DATA_DIRS.slice(1)) {
      delete env.XDG_DATA_DIRS
    }
    // The AppImage runtime consumes --appimage-extract-and-run before starting Electron.
    if (appImageEphemeralRootOf(process.execPath)?.kind === 'extract') {
      env.APPIMAGE_EXTRACT_AND_RUN = '1'
    }
    // Electron's Linux relauncher sets NO_NEW_PRIVS, which blocks setuid fusermount.
    return spawnProcess({
      program: 'bash',
      args: [
        '-pc',
        RELAUNCH_SCRIPT,
        'orca-appimage-relaunch',
        String(process.pid),
        String(process.ppid),
        failureLog,
        appImagePath,
        ...args
      ],
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
  })

  const { stdin, stdout } = child
  const failure = new AbortController()
  const fail = (error: Error): void => failure.abort(error)
  child.on('error', fail)
  child.on('exit', (code, exitSignal) =>
    fail(new Error(`AppImage launcher exited (${exitSignal ?? code}).`))
  )
  if (!stdin || !stdout) {
    child.kill()
    throw new Error('AppImage launcher is missing its control streams.')
  }
  stdin.on('error', fail)
  stdout.on('error', fail)
  const cancel = (): void => {
    stdin.destroy()
    stdout.destroy()
    child.unref()
  }
  try {
    const [response] = await once(stdout, 'data', {
      signal: AbortSignal.any([
        signal,
        failure.signal,
        AbortSignal.timeout(RELAUNCH_CHECK_TIMEOUT_MS)
      ])
    })
    if (String(response) !== 'ready\n') {
      throw new Error('AppImage launcher could not access the AppImage or host sleep command.')
    }
    return {
      cancel,
      async reportFailure(error) {
        const message = error instanceof Error ? error.message : String(error)
        const result = await settleWithinMs(
          writeFile(failureLog, `Could not restart Orca: ${message}\nReopen Orca manually.\n`, {
            flag: 'wx',
            mode: 0o600
          }),
          RELAUNCH_CHECK_TIMEOUT_MS
        )
        if (result.outcome !== 'settled') {
          console.error('[app] Could not save the AppImage restart diagnostic:', result)
        }
      },
      async commit() {
        try {
          if ((await resolveRestartArtifact()) !== appImagePath) {
            throw new Error('The original AppImage moved or became unusable during restart.')
          }
          failure.signal.throwIfAborted()
          // A single short write authorizes the detached child. EOF alone always cancels it.
          await new Promise<void>((resolve, reject) => {
            stdin.write('restart\n', (error) => (error ? reject(error) : resolve()))
          })
        } finally {
          cancel()
        }
      }
    }
  } catch (error) {
    cancel()
    throw failure.signal.reason ?? error
  }
}
