import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { getLauncherBaseName } from './editor-launcher-name'

type KnownPathOptions = {
  platform?: NodeJS.Platform
  homePath?: string
  env?: NodeJS.ProcessEnv
}

function isInsidersLauncher(baseName: string): boolean {
  return baseName === 'code-insiders' || baseName === 'code - insiders'
}

function isVsCodeCliBaseName(baseName: string): boolean {
  return baseName === 'code' || isInsidersLauncher(baseName)
}

/** Standard install locations when PATH resolution misses (GUI-launched Electron). */
export function listKnownVsCodeCliPaths(command: string, options: KnownPathOptions = {}): string[] {
  const baseName = getLauncherBaseName(command)
  if (!isVsCodeCliBaseName(baseName)) {
    return []
  }

  const platform = options.platform ?? process.platform
  const homePath = options.homePath ?? homedir()
  const env = options.env ?? process.env
  const insiders = isInsidersLauncher(baseName)

  if (platform === 'darwin') {
    const app = insiders ? 'Visual Studio Code - Insiders.app' : 'Visual Studio Code.app'
    const relative = join(app, 'Contents', 'Resources', 'app', 'bin', 'code')
    return [join('/Applications', relative), join(homePath, 'Applications', relative)]
  }

  if (platform === 'win32') {
    const binName = insiders ? 'code-insiders.cmd' : 'code.cmd'
    const product = insiders ? 'Microsoft VS Code Insiders' : 'Microsoft VS Code'
    const candidates: string[] = []
    const localAppData = env.LOCALAPPDATA?.trim()
    if (localAppData) {
      candidates.push(win32.join(localAppData, 'Programs', product, 'bin', binName))
    }
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
      const trimmed = root?.trim()
      if (trimmed) {
        candidates.push(win32.join(trimmed, product, 'bin', binName))
      }
    }
    return candidates
  }

  if (platform === 'linux') {
    if (insiders) {
      return ['/usr/share/code-insiders/bin/code-insiders', '/snap/bin/code-insiders']
    }
    return ['/usr/share/code/bin/code', '/usr/bin/code', '/snap/bin/code']
  }

  return []
}

export function resolveKnownVsCodeCliPath(
  command: string,
  fileExists: (path: string) => boolean,
  options: KnownPathOptions = {}
): string | null {
  for (const candidate of listKnownVsCodeCliPaths(command, options)) {
    if (fileExists(candidate)) {
      return candidate
    }
  }
  return null
}
