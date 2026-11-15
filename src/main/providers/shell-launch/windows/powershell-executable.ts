import { win32 as pathWin32 } from 'node:path'
import { readWindowsEnv } from './pwsh-discovery'
import {
  findWindowsPowerShell,
  findWindowsPwsh,
  type WindowsPowerShellResolveOptions
} from './powershell-search'

export type { WindowsPowerShellResolveOptions }

export function getWindowsCmdPath(env: NodeJS.ProcessEnv = process.env): string {
  const comspec = readWindowsEnv([env], ['ComSpec', 'COMSPEC'])
  if (comspec) {
    return comspec
  }
  const systemRoot = readWindowsEnv([env], ['SystemRoot', 'WINDIR', 'windir']) || 'C:\\Windows'
  return pathWin32.join(systemRoot, 'System32', 'cmd.exe')
}

/** Deduplicated requested PowerShell → inbox PowerShell → cmd.exe fallback paths. */
export async function resolveWindowsPowerShellSpawnChain(
  requestedFamily: 'pwsh.exe' | 'powershell.exe',
  options: WindowsPowerShellResolveOptions = {}
): Promise<string[]> {
  const env = options.env ?? process.env
  const isWindows = (options.platform ?? process.platform) === 'win32'
  const [pwsh, windowsPowerShell] = isWindows
    ? await Promise.all([
        requestedFamily === 'pwsh.exe' ? findWindowsPwsh(options) : null,
        // Inbox PowerShell avoids Store alias launch hazards.
        findWindowsPowerShell(env)
      ])
    : [null, null]
  // cmd.exe remains the last attempt when policy blocks both PowerShell variants.
  const chain = [pwsh, windowsPowerShell, getWindowsCmdPath(env)].filter(
    (candidate): candidate is string => Boolean(candidate)
  )
  const seen = new Set<string>()
  return chain
    .map((candidate) => pathWin32.normalize(candidate))
    .filter((candidate) => {
      const key = candidate.toLowerCase()
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
}
