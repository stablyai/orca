import { isSkillInstallProviderId } from '../../shared/skill-install-providers'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from '../../shared/tui-agent-detection-commands'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { runWslProcess } from '../wsl/wsl-runner'

const PROVIDER_DETECTION_COMMANDS = KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter((command) =>
  isSkillInstallProviderId(command.id)
)

const DETECTION_SCRIPT = [
  `for cmd in ${getTuiAgentDetectionProbeCommands(PROVIDER_DETECTION_COMMANDS, 'wsl')
    .map(quotePosixShell)
    .join(' ')}; do`,
  'command -v "$cmd" >/dev/null 2>&1 && printf "%s\\n" "$cmd"',
  'done',
  'true'
].join('\n')

export async function detectSkillProvidersInWsl(distro: string): Promise<string[]> {
  let result
  try {
    // Why probe: a bare `sh -c` has no login shell, so a PATH built by nvm/mise
    // rc files never applies and an installed agent reads as absent.
    result = await runWslProcess({
      distro,
      loginPath: 'preferred',
      script: DETECTION_SCRIPT,
      // POSIX `command -v` loop; declared because the payload is opaque here.
      shell: 'sh',
      timeoutMs: 10_000
    })
  } catch {
    throw new Error('skill-install-wsl-provider-detection-failed')
  }
  if (result.code !== 0) {
    throw new Error('skill-install-wsl-provider-detection-failed')
  }
  // Unconditional, not just on an empty list: the script always exits 0, so
  // without the login PATH each lookup independently reads absent. A `claude`
  // on the default PATH via Windows interop plus an nvm-only `codex` returns a
  // plausible-looking `['claude']`, and the caller then skips the ~/.codex
  // skill roots for a provider that is installed (#9725).
  if (!result.environmentResolved) {
    throw new Error('skill-install-wsl-provider-detection-failed')
  }
  return resolveDetectedTuiAgentIds(
    PROVIDER_DETECTION_COMMANDS,
    new Set(result.stdout.split(/\r?\n/u)),
    'wsl'
  )
}
