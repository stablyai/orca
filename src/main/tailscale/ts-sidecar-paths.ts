import { join } from 'path'

// Why: the binary is built per platform/arch and shipped via electron-builder
// extraResources, the same scheme agent-browser uses. The name encodes the
// target so a single resources/ts-sidecar dir can hold every platform.
export function tsSidecarBinaryName(platform: NodeJS.Platform, arch: string): string {
  const ext = platform === 'win32' ? '.exe' : ''
  return `ts-sidecar-${platform}-${arch}${ext}`
}

export type SidecarPathContext = {
  platform: NodeJS.Platform
  arch: string
  /** Electron's resolved resourcesPath in a packaged build, if available. */
  resourcesPath?: string
  /** Project root (app.getAppPath()) for the dev fallback. */
  appPath: string
}

/** Ordered candidate locations for the sidecar binary; the first that exists on
 *  disk wins. Packaged resources take priority over the dev build output. */
export function tsSidecarBinaryCandidates(ctx: SidecarPathContext): string[] {
  const name = tsSidecarBinaryName(ctx.platform, ctx.arch)
  const candidates: string[] = []
  if (ctx.resourcesPath) {
    candidates.push(join(ctx.resourcesPath, 'ts-sidecar', name))
  }
  // Dev: the binary built into the Go module directory by the build script.
  candidates.push(join(ctx.appPath, 'native', 'ts-sidecar', name))
  return candidates
}

/** Directory holding the persisted tailnet node key, so the device stays the
 *  same tailnet node across launches and re-auth is rare. */
export function tsSidecarStateDir(userDataPath: string): string {
  return join(userDataPath, 'tailnet')
}
