// Finds and runs updates for the user's own agent CLIs on this host.

import { homedir } from 'node:os'
import { runProcess } from '@orca/process-host'
import {
  isAgentCliUpdateAgent,
  LEGACY_AGENT_CLI_UPDATE_AGENTS,
  type AgentCliUpdate,
  type AgentCliUpdateAgent,
  type AgentCliUpdateRunResult
} from '../../shared/agent-launch/installation/agent-cli-update'
import { compareAppVersions } from '../../shared/app-lifecycle/identity/app-version'
import { isTuiAgentEnabled } from '../../shared/agent-launch/catalog/tui-agent-selection'
import { readAgentCliVersion } from '../agent-launch/preflight/agent-cli-version-probe'
import { agentModelCatalogInputStamp } from '../native-chat/agent-model-catalog/agent-model-catalog-input-stamp'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  findOwnAgentCli,
  type AgentCliUpdateSettings,
  type OwnAgentCli
} from './agent-cli-own-install'
import { latestAgentCliRelease } from './agent-cli-latest-release'
import { readModelsNeedingCliUpdate } from './agent-cli-model-requirements'
import { agentCliUpdateDefinition, type AgentCliUpdatePlan } from './agent-cli-update-agents'

const UPDATE_TIMEOUT_MS = 10 * 60_000
const UPDATE_OUTPUT_BYTES = 64 * 1024
// An unread version (e.g. a slow first start) is asked again after this, not on every check.
const UNREAD_RETRY_MS = 10 * 60_000

const versions = new Map<string, { stamp: string; version: string | null; at: number }>()
const checks = new Map<AgentCliUpdateAgent, Promise<AgentCliUpdate | null>>()
const runs = new Map<AgentCliUpdateAgent, Promise<AgentCliUpdateRunResult>>()

/**
 * Runs --version only when the installed file changed, or when an unread version (any version with
 * `recheck`) is due again. A failed recheck keeps the version it last read.
 */
async function installedVersion(
  agent: AgentCliUpdateAgent,
  cli: OwnAgentCli,
  recheck = false
): Promise<string | null> {
  const input = {
    program: cli.program,
    prefixArgs: cli.version.prefixArgs,
    cwd: homedir(),
    env: cli.version.env
  }
  const stamp = await agentModelCatalogInputStamp({
    command: cli.program,
    cwd: input.cwd,
    env: cli.env
  })
  const { parseVersion } = agentCliUpdateDefinition(agent)
  const known = versions.get(cli.program)
  const unchanged = known?.stamp === stamp
  if (unchanged && ((known.version && !recheck) || Date.now() - known.at < UNREAD_RETRY_MS)) {
    return known.version
  }
  const read = parseVersion
    ? await readAgentCliVersion(input, parseVersion)
    : await readAgentCliVersion(input)
  // Hermes' --version can outlast the probe while it checks for updates itself.
  const version = read.version ?? (unchanged ? known.version : null)
  versions.set(cli.program, { stamp, version, at: Date.now() })
  return version
}

function updatePlan(agent: AgentCliUpdateAgent, cli: OwnAgentCli, version: string) {
  return agentCliUpdateDefinition(agent).plan(version, cli.realPath)
}

function planCommand(cli: OwnAgentCli, plan: AgentCliUpdatePlan): string {
  return plan.runnable ? [cli.command, ...plan.args].join(' ') : plan.command
}

function latestRelease(agent: AgentCliUpdateAgent, installed: string): Promise<string | null> {
  return latestAgentCliRelease(agentCliUpdateDefinition(agent).latest(installed))
}

async function behindRelease(
  agent: AgentCliUpdateAgent,
  cli: OwnAgentCli,
  recheck: boolean
): Promise<{ version: string; latest: string } | null> {
  const version = await installedVersion(agent, cli, recheck)
  // Which release line is latest can depend on the installed major.
  const latest = version ? await latestRelease(agent, version) : null
  return version && latest && compareAppVersions(version, latest) < 0 ? { version, latest } : null
}

async function readAgentCliUpdate(
  agent: AgentCliUpdateAgent,
  settings: AgentCliUpdateSettings
): Promise<AgentCliUpdate | null> {
  const cli = await findOwnAgentCli(agent, settings)
  if (!cli) {
    return null
  }
  let behind = await behindRelease(agent, cli, false)
  // A launcher that runs a copy updated elsewhere only looks behind until its version is read again.
  if (behind && agentCliUpdateDefinition(agent).updatesOutsideLauncher) {
    behind = await behindRelease(agent, cli, true)
  }
  if (!behind) {
    return null
  }
  const { version, latest } = behind
  const plan = updatePlan(agent, cli, version)
  const models = await readModelsNeedingCliUpdate(agent, version, latest)
  return {
    agent,
    installedVersion: version,
    latestVersion: latest,
    command: planCommand(cli, plan),
    runnable: plan.runnable,
    ...(models.length > 0 ? { models } : {})
  }
}

/** Enabled agents among `requested` whose own CLI is behind its latest release. */
export async function checkAgentCliUpdates(
  settings: AgentCliUpdateSettings,
  requested: readonly string[] = LEGACY_AGENT_CLI_UPDATE_AGENTS
): Promise<AgentCliUpdate[]> {
  const agents = [...new Set(requested)].filter(
    (agent): agent is AgentCliUpdateAgent =>
      isAgentCliUpdateAgent(agent) && isTuiAgentEnabled(agent, settings.disabledTuiAgents)
  )
  const updates = await Promise.all(
    agents.map((agent) => {
      // Clients asking at once share one read.
      let check = checks.get(agent)
      if (!check) {
        check = readAgentCliUpdate(agent, settings)
          .catch((error: unknown) => {
            console.warn(`[agent-cli-update] ${agent} not checked:`, error)
            return null
          })
          .finally(() => checks.delete(agent))
        checks.set(agent, check)
      }
      return check
    })
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
  // An unread version compares equal to every gate, so the agent's own update still runs.
  const plan = updatePlan(agent, cli, version ?? '')
  if (!plan.runnable) {
    return { ok: false, output: `Run this to update:\n${plan.command}` }
  }
  const command = planCommand(cli, plan)
  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess(
      {
        program: cli.program,
        args: [...plan.args],
        cwd: homedir(),
        env: cli.env,
        timeoutMs: UPDATE_TIMEOUT_MS,
        maxOutputBytes: UPDATE_OUTPUT_BYTES,
        terminationBarrier: true
      },
      'tail'
    )
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error), command }
  }
  // The update may leave the launcher file untouched, so its version is read again.
  versions.delete(cli.program)
  // New chats and the model list read the replaced binary.
  agentModelCatalogStore.expireLaunchScopes((catalogAgent) => catalogAgent === agent)
  const output = [result.stdout, result.stderr]
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n')
  if (result.code !== 0 || result.timedOut) {
    return { ok: false, output, command }
  }
  const after = await installedVersion(agent, cli)
  const latest = after ? await latestRelease(agent, after) : null
  // A package manager behind the release (e.g. Homebrew) exits cleanly on the old version.
  if (after && latest && compareAppVersions(after, latest) < 0) {
    return { ok: false, output, command }
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
