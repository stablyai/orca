import { app } from 'electron'
import { join } from 'node:path'

export function electronWaylandHelperPath(): string {
  const program = 'orca-wayland-clipboard'
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', program)
    : join(app.getAppPath(), 'native', 'wayland-clipboard', '.build', process.arch, program)
}
