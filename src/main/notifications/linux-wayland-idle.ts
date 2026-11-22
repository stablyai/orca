import { spawnProcess } from '@orca/process-host'
import { createInterface } from 'node:readline'
import { DESKTOP_AWAY_SECONDS } from '../../shared/app-lifecycle/presence/desktop-away-threshold'
import { envWithoutAppImageRuntime } from '../pty/shell-startup/appimage-terminal-env'

export function watchLinuxWaylandIdle(
  program: string,
  onIdle: (idle: boolean | undefined) => void
): () => void {
  const env = envWithoutAppImageRuntime(process.env)
  // A WAYLAND_SOCKET fd supplied to Orca is not inherited by the helper.
  delete env.WAYLAND_SOCKET
  let child: ReturnType<typeof spawnProcess>
  try {
    child = spawnProcess({
      program,
      args: ['--watch-idle', String(DESKTOP_AWAY_SECONDS * 1000)],
      env,
      stdio: ['pipe', 'pipe', 'ignore']
    })
  } catch {
    return () => {}
  }

  const lines = createInterface({ input: child.stdout! })
  let stopped = false
  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    lines.close()
    child.stdin?.destroy()
    child.kill()
  }
  const unavailable = (): void => {
    if (!stopped) {
      stop()
      onIdle(undefined)
    }
  }
  child.on('error', unavailable)
  child.once('close', unavailable)
  child.stdin?.on('error', unavailable)
  lines.on('error', unavailable)
  lines.on('line', (line) => {
    if (!stopped && (line === 'idled' || line === 'resumed')) {
      onIdle(line === 'idled')
    }
  })
  return stop
}
