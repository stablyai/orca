// How each agent's own CLI reports its version, where its releases are published, and how it updates.

import type { AgentCliUpdateAgent } from '../../shared/agent-launch/installation/agent-cli-update'
import {
  compareAppVersions,
  parseCliVersion
} from '../../shared/app-lifecycle/identity/app-version'
import { parseCodexCliVersion } from '../../shared/agent-launch/startup/codex-cli-installation'
import { agentSessionInstallCommand } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { AgentCliReleaseSource } from './agent-cli-latest-release'

/** Runs `args` on the found CLI, or names a command the user runs themselves. */
export type AgentCliUpdatePlan =
  | { runnable: true; args: readonly string[] }
  | { runnable: false; command: string }

type AgentCliUpdateDefinition = {
  parseVersion?: typeof parseCliVersion
  /** Its launcher runs a newer copy from elsewhere, so an unchanged file doesn't mean an unchanged version. */
  updatesOutsideLauncher?: true
  latest: (installed: string) => AgentCliReleaseSource
  plan: (installed: string, realPath: string) => AgentCliUpdatePlan
}

const npm = (pkg: string): AgentCliReleaseSource => ({ kind: 'npm', package: pkg })
const selfUpdate = (...args: string[]): (() => AgentCliUpdatePlan) => {
  const plan: AgentCliUpdatePlan = { runnable: true, args }
  return () => plan
}

// `codex update` arrived in 0.126.0; older builds are updated by hand.
const CODEX_UPDATE_COMMAND_SINCE = '0.126.0'
// Below 2.0.0 is the archived Python CLI, which Kimi Code replaces rather than updates.
const KIMI_CODE_SINCE = '2.0.0'

function manualCodexUpdateCommand(realPath: string): string {
  const path = realPath.replaceAll('\\', '/')
  if (path.includes('/node_modules/@openai/codex/')) {
    return 'npm install -g @openai/codex@latest'
  }
  if (/\/(Caskroom|Cellar)\/codex\//.test(path)) {
    return 'brew upgrade codex'
  }
  return agentSessionInstallCommand('codex', process.platform) ?? 'codex update'
}

// Each self-update follows how the CLI was installed (native, npm, bun, Homebrew), and a
// package manager behind the release is caught by the version read after it.
const AGENT_CLI_UPDATE_DEFINITIONS: Record<AgentCliUpdateAgent, AgentCliUpdateDefinition> = {
  claude: { latest: () => ({ kind: 'claude' }), plan: selfUpdate('update') },
  codex: {
    parseVersion: parseCodexCliVersion,
    // Codex's npm, Homebrew and standalone builds all publish from this release.
    latest: () => ({ kind: 'github', repo: 'openai/codex', tagPrefix: 'rust-v' }),
    plan: (installed, realPath) =>
      compareAppVersions(installed, CODEX_UPDATE_COMMAND_SINCE) >= 0
        ? { runnable: true, args: ['update'] }
        : { runnable: false, command: manualCodexUpdateCommand(realPath) }
  },
  // `grok update` follows the stable channel, which npm's latest tag carries.
  grok: { latest: () => npm('@xai-official/grok'), plan: selfUpdate('update') },
  // `opencode upgrade` stays on the installed major: 1.x ships as opencode-ai, 2.x as @opencode/cli.
  opencode: {
    latest: (installed) =>
      npm(compareAppVersions(installed, '2.0.0') >= 0 ? '@opencode/cli' : 'opencode-ai'),
    plan: selfUpdate('upgrade')
  },
  opencode2: { latest: () => npm('@opencode/cli'), plan: selfUpdate('upgrade') },
  omp: { latest: () => npm('@oh-my-pi/pi-coding-agent'), plan: selfUpdate('update') },
  // An npm install's loader runs the newest copy in Copilot's package cache.
  copilot: {
    updatesOutsideLauncher: true,
    latest: () => npm('@github/copilot'),
    plan: selfUpdate('update')
  },
  kimi: {
    latest: () => npm('@moonshot-ai/kimi-code'),
    plan: (installed) =>
      compareAppVersions(installed, KIMI_CODE_SINCE) >= 0
        ? { runnable: true, args: ['update', '--yes'] }
        : {
            runnable: false,
            command:
              agentSessionInstallCommand('kimi', process.platform) ??
              'https://moonshotai.github.io/kimi-code/'
          }
  },
  cursor: {
    // The build hash would read as a prerelease of the date it was built on.
    parseVersion: (output) => parseCliVersion(output)?.split('-')[0] ?? null,
    latest: () => ({ kind: 'acp-registry', id: 'cursor' }),
    plan: selfUpdate('update')
  },
  // `hermes update` restarts the profile's gateways, which serve its open chats, so the user runs it.
  hermes: {
    latest: () => ({ kind: 'github', repo: 'NousResearch/hermes-agent', tagPrefix: 'v' }),
    plan: () => ({ runnable: false, command: 'hermes update' })
  }
}

export function agentCliUpdateDefinition(agent: AgentCliUpdateAgent): AgentCliUpdateDefinition {
  return AGENT_CLI_UPDATE_DEFINITIONS[agent]
}
