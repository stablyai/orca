import { platform, arch } from 'node:os'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { agentBrowserDependencyBinaryPath } from '../../../../shared/remote-runtime/orcad-distribution/orcad-agent-browser-name'

export function agentBrowserNativeName(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return `agent-browser-${platform()}-${arch()}${ext}`
}

export function resolveAgentBrowserBinary(): string {
  // resourcesPath preserves the case-sensitive macOS Resources path.
  const bundledResourcesPath =
    process.resourcesPath ??
    (process.platform === 'darwin'
      ? join(app.getPath('exe'), '..', '..', 'Resources')
      : join(app.getPath('exe'), '..', 'resources'))
  const bundled = join(bundledResourcesPath, agentBrowserNativeName())
  if (existsSync(bundled)) {
    return bundled
  }

  // Bundling makes __dirname unreliable for locating development dependencies.
  const nmBin = join(
    app.getAppPath(),
    ...agentBrowserDependencyBinaryPath(process.platform, arch())
  )
  if (existsSync(nmBin)) {
    return nmBin
  }

  return 'agent-browser'
}
