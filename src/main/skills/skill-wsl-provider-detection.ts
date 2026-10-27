import { isSkillInstallProviderId } from '../../shared/skill-install-providers'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from '../../shared/tui-agent-detection-commands'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
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
    // Resolve login PATH so nvm/mise-installed agents do not look absent.
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
  // Require resolved PATH even for nonempty output: Windows interop may find Claude while hiding nvm-only Codex (#9725).
  if (!result.environmentResolved) {
    throw new Error('skill-install-wsl-provider-detection-failed')
  }
  return resolveDetectedTuiAgentIds(
    PROVIDER_DETECTION_COMMANDS,
    new Set(result.stdout.split(/\r?\n/u)),
    'wsl'
  )
}
