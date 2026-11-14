import { accessSync, chmodSync, constants } from 'node:fs'

/** pnpm skips agent-browser's postinstall, which is what marks its tarball binaries executable. */
export function ensureDependencyBinaryExecutable(path: string): void {
  if (process.platform === 'win32') {
    return
  }
  try {
    accessSync(path, constants.X_OK)
  } catch {
    chmodSync(path, 0o755)
  }
}
