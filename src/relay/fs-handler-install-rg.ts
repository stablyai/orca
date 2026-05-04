import { readFile } from 'fs/promises'

export async function detectInstallCommand(): Promise<string> {
  if (process.platform === 'darwin') {
    return 'brew install ripgrep'
  }
  if (process.platform === 'linux') {
    try {
      const osRelease = await readFile('/etc/os-release', 'utf-8')
      const idMatch = osRelease.match(/^ID=(?:"?)([^"\n]+)(?:"?)$/m)
      const idLikeMatch = osRelease.match(/^ID_LIKE=(?:"?)([^"\n]+)(?:"?)$/m)
      const ids = [idMatch?.[1], ...(idLikeMatch?.[1]?.split(/\s+/) ?? [])].filter(Boolean)
      for (const id of ids) {
        if (id === 'debian' || id === 'ubuntu') {
          return 'sudo apt install ripgrep'
        }
        if (id === 'fedora' || id === 'rhel' || id === 'centos') {
          return 'sudo dnf install ripgrep'
        }
        if (id === 'arch') {
          return 'sudo pacman -S ripgrep'
        }
        if (id === 'alpine') {
          return 'sudo apk add ripgrep'
        }
      }
    } catch {
      /* fall through to generic guidance */
    }
    return 'install ripgrep via your package manager (e.g. apt/dnf/pacman)'
  }
  return 'install ripgrep (https://github.com/BurntSushi/ripgrep#installation)'
}

export async function buildInstallRgMessage(cause: unknown): Promise<string> {
  const reason = cause instanceof Error ? cause.message : String(cause)
  const cmd = await detectInstallCommand()
  return (
    `Quick Open scan too large (${reason}). ` +
    `Install ripgrep on the remote to enable fast, gitignore-aware listing: ${cmd}`
  )
}
