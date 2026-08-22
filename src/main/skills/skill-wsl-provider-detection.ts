import { runWslProcess } from '../wsl/wsl-runner'

const DETECTION_SCRIPT = [
  'set -eu',
  'command -v codex >/dev/null 2>&1 && printf "codex\\n" || true',
  'command -v claude >/dev/null 2>&1 && printf "claude\\n" || true'
].join('\n')

export async function detectSkillProvidersInWsl(distro: string): Promise<string[]> {
  let result
  try {
    // Why probe: a bare `sh -c` has no login shell, so a PATH built by nvm/mise
    // rc files never applies and an installed codex/claude reads as absent.
    result = await runWslProcess({
      distro,
      lane: 'probe',
      script: DETECTION_SCRIPT,
      timeoutMs: 10_000
    })
  } catch {
    throw new Error('skill-install-wsl-provider-detection-failed')
  }
  if (result.code !== 0) {
    throw new Error('skill-install-wsl-provider-detection-failed')
  }
  return result.stdout
    .split(/\r?\n/u)
    .filter((provider) => provider === 'codex' || provider === 'claude')
}
