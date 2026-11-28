// Finds and runs updates for the user's own agent CLIs on this host.

import { homedir } from 'node:os'
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
import { checkThroughGate, updateThroughGate } from './agent-cli-update-gate'
import { runAgentCliUpdater, type UpdaterRun } from './agent-cli-updater-process'
import { PrioritySemaphore } from '../../shared/concurrency/priority-semaphore'
import { notifyAgentCliUpdateFinished } from './agent-cli-update-events'

export {
  announceAgentCliUpdatesFinished,
  onAgentCliUpdateFinished
} from './agent-cli-update-events'

// An unread version (e.g. a slow first start) is asked again after this, not on every check.
const UNREAD_RETRY_MS = 10 * 60_000
// Each --version starts a full CLI runtime (often Node); a dozen at once spikes memory and CPU.
const versionReads = new PrioritySemaphore(3)

const versions = new Map<string, { stamp: string; version: string | null; at: number }>()
const checks = new Map<AgentCliUpdateAgent, Promise<AgentCliUpdate | null>>()
const runs = new Map<AgentCliUpdateAgent, Promise<AgentCliUpdateRunResult>>()
// Calls of checkAgentCliUpdates not yet answered, with the agents updated while they were out.
const answering = new Set<{
  agents: readonly AgentCliUpdateAgent[]
  updated: Set<AgentCliUpdateAgent>
}>()

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
  const release = await versionReads.acquire(0)
  let read: Awaited<ReturnType<typeof readAgentCliVersion>>
  try {
    read = parseVersion
      ? await readAgentCliVersion(input, parseVersion)
      : await readAgentCliVersion(input)
  } finally {
    release()
  }
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
  const call = { agents, updated: new Set<AgentCliUpdateAgent>() }
  answering.add(call)
  try {
    const updates = await Promise.all(agents.map((agent) => sharedCheck(agent, settings)))
    // An agent updated while this was out is read again, after its update.
    while (call.updated.size > 0) {
      const again = [...call.updated]
      call.updated.clear()
      const fresh = await Promise.all(again.map((agent) => sharedCheck(agent, settings)))
      again.forEach((agent, index) => {
        updates[agents.indexOf(agent)] = fresh[index]
      })
    }
    return updates.filter((update) => update !== null)
  } finally {
    answering.delete(call)
  }
}

/** Clients asking at once share one read of each agent. */
function sharedCheck(
  agent: AgentCliUpdateAgent,
  settings: AgentCliUpdateSettings
): Promise<AgentCliUpdate | null> {
  let check = checks.get(agent)
  if (!check) {
    check = checkThroughGate(agent, () => readAgentCliUpdate(agent, settings))
      .catch((error: unknown) => {
        console.warn(`[agent-cli-update] ${agent} not checked:`, error)
        return null
      })
      .finally(() => {
        if (checks.get(agent) === check) {
          checks.delete(agent)
        }
      })
    checks.set(agent, check)
  }
  return check
}

function runUpdate(
  agent: AgentCliUpdateAgent,
  settings: AgentCliUpdateSettings
): Promise<AgentCliUpdateRunResult> {
  // Later checks start their own read behind the update, and calls already out read this agent again.
  checks.delete(agent)
  for (const call of answering) {
    if (call.agents.includes(agent)) {
      call.updated.add(agent)
    }
  }
  return updateThroughGate(agent, () => updateAgentCli(agent, settings))
}

async function updateAgentCli(
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
  let result: UpdaterRun
  try {
    result = await runAgentCliUpdater({
      program: cli.program,
      args: plan.args,
      cwd: homedir(),
      env: cli.env
    })
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error), command }
  }
  // New chats and the model list read the replaced binary.
  agentModelCatalogStore.expireLaunchScopes((catalogAgent) => catalogAgent === agent)
  // The update may move the binary or leave its launcher untouched, so the CLI a new chat finds is read anew.
  const updated = (await findOwnAgentCli(agent, settings).catch(() => null)) ?? cli
  versions.delete(cli.program)
  versions.delete(updated.program)
  const after = await installedVersion(agent, updated)
  const output = [result.stdout, result.stderr, result.stoppedBecause ?? '']
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n')
  const latest = after ? await latestRelease(agent, after) : null
  // The version decides when readable: a failed run that leaves the CLI at the latest release is done
  // (e.g. a wrapper around a desktop app's CLI), and a clean exit still behind it (e.g. Homebrew) is not.
  const current =
    after && latest
      ? compareAppVersions(after, latest) >= 0
      : result.code === 0 && result.stoppedBecause === null
  return current ? { ok: true } : { ok: false, output, command }
}

/** Joins an update of `agent` already running on this host. */
export function runAgentCliUpdate(
  agent: AgentCliUpdateAgent,
  settings: AgentCliUpdateSettings
): Promise<AgentCliUpdateRunResult> {
  let run = runs.get(agent)
  if (!run) {
    run = runUpdate(agent, settings).finally(() => {
      runs.delete(agent)
      notifyAgentCliUpdateFinished(agent)
    })
    runs.set(agent, run)
  }
  return run
}
