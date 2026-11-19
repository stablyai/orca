import { accessSync, constants, existsSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'
import {
  agentBrowserDependencyBinaryPath,
  orcadAgentBrowserNativeName
} from '../../../shared/remote-runtime/orcad-distribution/orcad-agent-browser-name'

/** A slot carries only its own target's driver, so trying both libc names needs no libc probe. */
function hostLibcs(): ('glibc' | 'musl')[] {
  return platform() === 'linux' ? ['glibc', 'musl'] : ['glibc']
}

export function resolveOrcadAgentBrowserBinary(): string | null {
  const candidates = hostLibcs().flatMap((libc) => [
    join(
      dirname(process.argv[1] ?? __filename),
      orcadAgentBrowserNativeName(platform(), arch(), libc)
    ),
    join(process.cwd(), ...agentBrowserDependencyBinaryPath(platform(), arch(), libc))
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
