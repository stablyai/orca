import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_HOST_DEV_PORT } from '../shared/desktop-host-protocol'

export type DesktopHostListenConfig = {
  host: string
  port: number
  userDataPath: string
}

function readPort(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid desktop host port: ${raw}`)
  }
  // Why: 6768 is the packaged Electron/runtime websocket. Dev and local
  // smoke must stay on a different port so they cannot steal production.
  if (parsed === 6768) {
    throw new Error(
      'Refusing to bind production websocket port 6768. Use 6769 for the Tauri desktop host.'
    )
  }
  return parsed
}

export function resolveDesktopHostListenConfig(
  env: NodeJS.ProcessEnv = process.env
): DesktopHostListenConfig {
  const port = readPort(env.ORCA_DESKTOP_HOST_PORT, DESKTOP_HOST_DEV_PORT)
  const userDataPath =
    env.ORCA_DESKTOP_USER_DATA_DIR?.trim() ||
    join(homedir() || tmpdir(), '.orca', 'tauri-desktop-host')
  return {
    host: '127.0.0.1',
    port,
    userDataPath
  }
}

export function formatDesktopHostHttpUrl(config: DesktopHostListenConfig): string {
  return `http://${config.host}:${config.port}`
}

export function formatDesktopHostIpcUrl(config: DesktopHostListenConfig): string {
  return `ws://${config.host}:${config.port}/desktop/ipc`
}
