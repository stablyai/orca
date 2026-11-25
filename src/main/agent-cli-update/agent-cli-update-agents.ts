// How each agent's own CLI reports its version, where its releases are published, and how it updates.

import type { AgentCliUpdateAgent } from '../../shared/agent-launch/installation/agent-cli-update'
import {
  compareAppVersions,
  parseCliVersion
} from '../../shared/app-lifecycle/identity/app-version'
import { parseCodexCliVersion } from '../../shared/agent-launch/startup/codex-cli-installation'
import { agentSessionInstallCommand } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { AgentCliReleaseSource } from './agent-cli-latest-release'
import {
  isHomebrewCask,
  packageUpgradeCommand,
  type AgentCliPackages,
  type AgentCliPaths
} from './agent-cli-package-install'

/** Runs `args` on the found CLI, or names a command the user runs themselves. */
export type AgentCliUpdatePlan =
  | { runnable: true; args: readonly string[] }
  | { runnable: false; command: string }

type AgentCliUpdateDefinition = {
  parseVersion?: typeof parseCliVersion
  /** Its launcher runs a newer copy from elsewhere, so an unchanged file doesn't mean an unchanged version. */
  updatesOutsideLauncher?: true
  /** Package installs its own update only prints the manager's command for; Orca names that command instead. */
  updatedByPackageManager?: AgentCliPackages
  latest: (installed: string, installPath: string) => AgentCliReleaseSource
  plan: (installed: string, cli: AgentCliPaths) => AgentCliUpdatePlan
}

const npm = (pkg: string): AgentCliReleaseSource => ({ kind: 'npm', package: pkg })
const selfUpdate = (...args: string[]): (() => AgentCliUpdatePlan) => {
  const plan: AgentCliUpdatePlan = { runnable: true, args }
  return () => plan
}

// `codex update` arrived in 0.126.0; older builds are updated by hand.
const CODEX_UPDATE_COMMAND_SINCE = '0.126.0'
// Earlier releases read `qwen update` as a prompt and run it.
const QWEN_UPDATE_COMMAND_SINCE = '0.20.0'
// Below 2.0.0 is the archived Python CLI, which Kimi Code replaces rather than updates.
const KIMI_CODE_SINCE = '2.0.0'

const CODEX_PACKAGES: AgentCliPackages = { homebrew: ['codex'], nodeGlobal: '@openai/codex' }
const QWEN_NPM_PACKAGE = '@qwen-code/qwen-code'

// Self-updates follow how the CLI was installed unless `updatedByPackageManager` says otherwise,
// and a package manager behind the release is caught by the version read after it.
const AGENT_CLI_UPDATE_DEFINITIONS: Record<AgentCliUpdateAgent, AgentCliUpdateDefinition> = {
  claude: {
    // The `claude-code` cask carries Claude's stable channel, whichever channel the user follows.
    latest: (_installed, installPath) =>
      isHomebrewCask(installPath, 'claude-code')
        ? { kind: 'claude', channel: 'stable' }
        : { kind: 'claude' },
    updatedByPackageManager: {
      homebrew: ['claude-code', 'claude-code@latest'],
      winget: 'Anthropic.ClaudeCode'
    },
    plan: selfUpdate('update')
  },
  codex: {
    parseVersion: parseCodexCliVersion,
    // Codex's npm, Homebrew and standalone builds all publish from this release.
    latest: () => ({ kind: 'github', repo: 'openai/codex', tagPrefix: 'rust-v' }),
    plan: (installed, cli) =>
      compareAppVersions(installed, CODEX_UPDATE_COMMAND_SINCE) >= 0
        ? { runnable: true, args: ['update'] }
        : {
            runnable: false,
            command:
              packageUpgradeCommand(cli, CODEX_PACKAGES) ??
              agentSessionInstallCommand('codex', process.platform) ??
              'codex update'
          }
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
    updatedByPackageManager: { homebrew: ['kimi-code'] },
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
  // It updates the checkout the launcher execs and leaves the launcher itself untouched.
  hermes: {
    updatesOutsideLauncher: true,
    latest: () => ({ kind: 'github', repo: 'NousResearch/hermes-agent', tagPrefix: 'v' }),
    plan: () => ({ runnable: false, command: 'hermes update' })
  },
  // `goose update` replaces its own binary with the stable release's.
  goose: {
    latest: () => ({ kind: 'github', repo: 'aaif-goose/goose', tagPrefix: 'v' }),
    plan: selfUpdate('update')
  },
  // `auggie upgrade` installs its prerelease channel, so the user installs npm's stable release.
  aug: {
    latest: () => npm('@augmentcode/auggie'),
    plan: () => ({ runnable: false, command: 'npm install -g @augmentcode/auggie@latest' })
  },
  // Both upgrade the way they were installed, as OpenCode 1.x does.
  kilo: { latest: () => npm('@kilocode/cli'), plan: selfUpdate('upgrade') },
  'mimo-code': { latest: () => npm('@mimo-ai/cli'), plan: selfUpdate('upgrade') },
  // `qwen update` updates only its standalone install, whose launcher runs the newest copy in its own folder.
  'qwen-code': {
    updatesOutsideLauncher: true,
    latest: () => npm(QWEN_NPM_PACKAGE),
    updatedByPackageManager: { homebrew: ['qwen-code'], nodeGlobal: QWEN_NPM_PACKAGE },
    plan: (installed) =>
      compareAppVersions(installed, QWEN_UPDATE_COMMAND_SINCE) >= 0
        ? { runnable: true, args: ['update'] }
        : {
            runnable: false,
            command:
              agentSessionInstallCommand('qwen-code', process.platform) ??
              `npm install -g ${QWEN_NPM_PACKAGE}@latest`
          }
  },
  // `devin update` needs a terminal: without one it exits 130 before checking.
  devin: {
    latest: () => ({ kind: 'acp-registry', id: 'devin' }),
    plan: () => ({ runnable: false, command: 'devin update' })
  },
  // `codebuddy update` follows how it was installed (npm, Homebrew or its native installer).
  codebuddy: { latest: () => npm('@tencent-ai/codebuddy-code'), plan: selfUpdate('update') }
}

export function agentCliUpdateDefinition(agent: AgentCliUpdateAgent): AgentCliUpdateDefinition {
  return AGENT_CLI_UPDATE_DEFINITIONS[agent]
}

export function agentCliUpdatePlan(
  agent: AgentCliUpdateAgent,
  installed: string,
  cli: AgentCliPaths
): AgentCliUpdatePlan {
  const { updatedByPackageManager, plan } = AGENT_CLI_UPDATE_DEFINITIONS[agent]
  const command = updatedByPackageManager
    ? packageUpgradeCommand(cli, updatedByPackageManager)
    : null
  return command ? { runnable: false, command } : plan(installed, cli)
}
