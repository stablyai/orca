import { accessSync, constants, existsSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'

export function orcadAgentBrowserNativeName(
  platformName: NodeJS.Platform,
  architecture: string
): string {
  const ext = platformName === 'win32' ? '.exe' : ''
  return `agent-browser-${platformName}-${architecture}${ext}`
}

export function resolveOrcadAgentBrowserBinary(): string | null {
  const name = orcadAgentBrowserNativeName(platform(), arch())
  const candidates = [
    join(dirname(process.argv[1] ?? __filename), name),
    join(process.cwd(), 'node_modules', 'agent-browser', 'bin', name)
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }
    try {
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return candidate
    } catch {
      // Keep searching; a copied but non-executable binary is not a provider.
    }
  }
  return null
}
