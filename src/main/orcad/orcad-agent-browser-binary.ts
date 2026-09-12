import { accessSync, constants, existsSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { orcadAgentBrowserNativeName } from '../../shared/orcad-agent-browser-name'
import { detectLibcFromReportHeader } from './native-host-abi'

export { orcadAgentBrowserNativeName } from '../../shared/orcad-agent-browser-name'

export function resolveOrcadAgentBrowserBinary(): string | null {
  let reportHeader: unknown
  try {
    reportHeader = (process.report?.getReport?.() as { header?: unknown } | undefined)?.header
  } catch {
    reportHeader = undefined
  }
  const { libc } = detectLibcFromReportHeader(process.platform, reportHeader)
  const name = orcadAgentBrowserNativeName(platform(), arch(), libc === 'musl' ? 'musl' : 'glibc')
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
