// Finds and runs updates for the user's own agent CLIs on this host.

import { homedir } from 'node:os'
import { runProcess } from '@orca/process-host'
import {
  AGENT_CLI_UPDATE_AGENTS,
  type AgentCliUpdate,
  type AgentCliUpdateAgent,
  type AgentCliUpdateRunResult
} from '../../shared/agent-launch/installation/agent-cli-update'
import { compareAppVersions } from '../../shared/app-lifecycle/identity/app-version'
import { parseCodexCliVersion } from '../../shared/agent-launch/startup/codex-cli-installation'
import { isTuiAgentEnabled } from '../../shared/agent-launch/catalog/tui-agent-selection'
import { agentSessionInstallCommand } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { readAgentCliVersion } from '../agent-launch/preflight/agent-cli-version-probe'
import { agentModelCatalogInputStamp } from '../native-chat/agent-model-catalog/agent-model-catalog-input-stamp'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  findOwnAgentCli,
  type AgentCliUpdateSettings,
  type OwnAgentCli
} from './agent-cli-own-install'
import { latestAgentCliRelease } from './agent-cli-latest-release'

// `codex update` arrived in 0.126.0; older builds are updated by hand.
const CODEX_UPDATE_COMMAND_SINCE = '0.126.0'
const UPDATE_TIMEOUT_MS = 10 * 60_000
const UPDATE_OUTPUT_BYTES = 64 * 1024

const versions = new Map<string, { stamp: string; version: string }>()
const runs = new Map<AgentCliUpdateAgent, Promise<AgentCliUpdateRunResult>>()

/** Runs --version only when the installed file changed since the last read. */
async function installedVersion(
  agent: AgentCliUpdateAgent,
  cli: OwnAgentCli
): Promise<string | null> {
  const input = { program: cli.program, cwd: homedir(), env: cli.env }
  const stamp = await agentModelCatalogInputStamp({
    command: cli.program,
    cwd: input.cwd,
    env: cli.env
  })
  const known = versions.get(cli.program)
  if (known?.stamp === stamp) {
    return known.version
  }
  const { version } =
    agent === 'codex'
      ? await readAgentCliVersion(input, parseCodexCliVersion)
      : await readAgentCliVersion(input)
  // An unread version (e.g. a slow first start) is asked again next time.
  if (version) {
    versions.set(cli.program, { stamp, version })
  }
  return version
}

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

function updateCommand(
  agent: AgentCliUpdateAgent,
  cli: OwnAgentCli,
  version: string
): Pick<AgentCliUpdate, 'command' | 'runnable'> {
  // Each CLI's own update follows how it was installed: native, npm, Homebrew or WinGet.
  if (agent === 'claude' || compareAppVersions(version, CODEX_UPDATE_COMMAND_SINCE) >= 0) {
    return { command: `${agent} update`, runnable: true }
  }
  return { command: manualCodexUpdateCommand(cli.realPath), runnable: false }
}

async function readAgentCliUpdate(
  agent: AgentCliUpdateAgent,
  settings: AgentCliUpdateSettings
): Promise<AgentCliUpdate | null> {
  const cli = await findOwnAgentCli(agent, settings)
  if (!cli) {
    return null
  }
  const [version, latest] = await Promise.all([
    installedVersion(agent, cli),
    latestAgentCliRelease(agent)
  ])
  if (!version || !latest || compareAppVersions(version, latest) >= 0) {
    return null
  }
  return {
    agent,
    installedVersion: version,
    latestVersion: latest,
    ...updateCommand(agent, cli, version)
  }
}

/** Enabled agents whose own CLI is behind its latest release. */
export async function checkAgentCliUpdates(
  settings: AgentCliUpdateSettings
): Promise<AgentCliUpdate[]> {
  const agents = AGENT_CLI_UPDATE_AGENTS.filter((agent) =>
    isTuiAgentEnabled(agent, settings.disabledTuiAgents)
  )
  const updates = await Promise.all(
    agents.map((agent) =>
      readAgentCliUpdate(agent, settings).catch((error: unknown) => {
        console.warn(`[agent-cli-update] ${agent} not checked:`, error)
        return null
      })
    )
  )
  return updates.filter((update) => update !== null)
}

async function runUpdate(
  agent: AgentCliUpdateAgent,
  settings: AgentCliUpdateSettings
): Promise<AgentCliUpdateRunResult> {
  const cli = await findOwnAgentCli(agent, settings)
  if (!cli) {
    return { ok: false, output: `No ${agent} command of your own was found on this computer.` }
  }
  const version = await installedVersion(agent, cli)
  const plan = version ? updateCommand(agent, cli, version) : null
  if (plan && !plan.runnable) {
    return { ok: false, output: `Run this to update:\n${plan.command}` }
  }
  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess(
      {
        program: cli.program,
        args: ['update'],
        cwd: homedir(),
        env: cli.env,
        timeoutMs: UPDATE_TIMEOUT_MS,
        maxOutputBytes: UPDATE_OUTPUT_BYTES,
        terminationBarrier: true
      },
      'tail'
    )
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  }
  // New chats and the model list read the replaced binary.
  agentModelCatalogStore.expireLaunchScopes((catalogAgent) => catalogAgent === agent)
  const output = [result.stdout, result.stderr]
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n')
  if (result.code !== 0 || result.timedOut) {
    return { ok: false, output }
  }
  const [after, latest] = await Promise.all([
    installedVersion(agent, cli),
    latestAgentCliRelease(agent)
  ])
  // A package manager behind the release (e.g. Homebrew) exits cleanly on the old version.
  if (after && latest && compareAppVersions(after, latest) < 0) {
    return { ok: false, output }
  }
  return { ok: true }
}

/** Joins an update of `agent` already running on this host. */
export function runAgentCliUpdate(
  agent: AgentCliUpdateAgent,
  settings: AgentCliUpdateSettings
): Promise<AgentCliUpdateRunResult> {
  let run = runs.get(agent)
  if (!run) {
    run = runUpdate(agent, settings).finally(() => runs.delete(agent))
    runs.set(agent, run)
  }
  return run
}
