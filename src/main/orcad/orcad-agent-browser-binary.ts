import { accessSync, constants, existsSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { orcadAgentBrowserNativeName } from '../../shared/orcad-agent-browser-name'

/** A slot carries only its own target's driver, so trying both libc names needs no libc probe. */
function hostDriverNames(): string[] {
  const names = [orcadAgentBrowserNativeName(platform(), arch())]
  if (platform() === 'linux') {
    names.push(orcadAgentBrowserNativeName('linux', arch(), 'musl'))
  }
  return names
}

export function resolveOrcadAgentBrowserBinary(): string | null {
  const candidates = hostDriverNames().flatMap((name) => [
    join(dirname(process.argv[1] ?? __filename), name),
    join(process.cwd(), 'node_modules', 'agent-browser', 'bin', name)
  ])
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
