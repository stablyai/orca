import { execFile } from 'node:child_process'

const DETECTION_SCRIPT = [
  'set -eu',
  'command -v codex >/dev/null 2>&1 && printf "codex\\n" || true',
  'command -v claude >/dev/null 2>&1 && printf "claude\\n" || true'
].join('\n')

export function detectSkillProvidersInWsl(distro: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      ['-d', distro, '--exec', 'sh', '-c', DETECTION_SCRIPT],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error('skill-install-wsl-provider-detection-failed'))
          return
        }
        resolve(
          stdout.split(/\r?\n/u).filter((provider) => provider === 'codex' || provider === 'claude')
        )
      }
    )
  })
}
