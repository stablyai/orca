import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import { AGENT_UPDATE_CATALOG } from '../../shared/agent-updates/agent-update-catalog'
import type { AgentUpdateInfo, AgentUpdateRow } from '../../shared/agent-updates/agent-update-types'
import { isUpdateAvailable, parseAgentVersion } from '../../shared/agent-updates/agent-version'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  agentCommandOverrideDetectionOptions,
  detectInstalledAgentsWithShellPathHydration
} from '../preflight/installed-agent-detection'
import { readInstalledVersion, resolveAgentBinary } from './agent-binary'
import { fetchLatestVersion } from './fetch-latest-version'
import { planAgentUpdate } from './update-plan'

export type AgentUpdateSettings = Pick<GlobalSettings, 'disabledTuiAgents' | 'agentCmdOverrides'>

export type AgentUpdateCheckResult = {
  rows: AgentUpdateRow[]
  /** False only when every latest-version lookup failed (e.g. offline), which is not "up to date". */
  sourcesReachable: boolean
}

const CHECK_CONCURRENCY = 4

type CheckTarget = { agent: TuiAgent; info: AgentUpdateInfo }

type AgentCheck = { row: AgentUpdateRow | null; latestFound: boolean }

// Why: followers (claude-agent-teams) share their leader's binary, so the leader's row covers them.
function checkTargets(installed: readonly string[]): CheckTarget[] {
  const targets: CheckTarget[] = []
  for (const agent of new Set(installed)) {
    if (!isTuiAgent(agent)) {
      continue
    }
    const info = AGENT_UPDATE_CATALOG[agent]
    if (info !== 'unsupported' && !('followsAgent' in info)) {
      targets.push({ agent, info })
    }
  }
  return targets
}

function majorOf(version: string): string {
  return version.split('.')[0]
}

/** Null when the agent's binary cannot be resolved, so no release source was asked. */
async function checkAgent(
  { agent, info }: CheckTarget,
  overrides: AgentUpdateSettings['agentCmdOverrides']
): Promise<AgentCheck | null> {
  const resolved = await resolveAgentBinary(agent, overrides)
  if (!resolved) {
    return null
  }
  const [installedOutput, latestOutput] = await Promise.all([
    readInstalledVersion(resolved.binary, info.versionArgs ?? ['--version']),
    fetchLatestVersion(info.latest)
  ])
  const current = installedOutput && parseAgentVersion(installedOutput)
  const latest = latestOutput && parseAgentVersion(latestOutput)
  if (!current) {
    console.warn(`[agent-updates] ${agent}: installed version unreadable; skipping`)
  }
  if (!latest) {
    console.warn(`[agent-updates] ${agent}: latest version unavailable; skipping`)
    return { row: null, latestFound: false }
  }
  if (!current || !isUpdateAvailable(current, latest, info.scheme ?? 'semver')) {
    return { row: null, latestFound: true }
  }
  if (info.sameMajorOnly && majorOf(current) !== majorOf(latest)) {
    return { row: null, latestFound: true }
  }
  const plan = planAgentUpdate(info, resolved, process.platform)
  if (!plan) {
    return { row: null, latestFound: true }
  }
  const row: AgentUpdateRow = {
    agent,
    current,
    latest,
    updateAvailable: true,
    action: plan.kind === 'process' ? { kind: 'run' } : { kind: 'manual', command: plan.command },
    run: null
  }
  return { row, latestFound: true }
}

/** Installed agents with a newer release; an agent that cannot be checked is left out. */
export async function checkAgentUpdates(
  settings: AgentUpdateSettings
): Promise<AgentUpdateCheckResult> {
  const installed = await detectInstalledAgentsWithShellPathHydration(undefined, {
    disabledTuiAgents: settings.disabledTuiAgents,
    ...agentCommandOverrideDetectionOptions(settings.agentCmdOverrides)
  })
  const checks = await mapWithConcurrency(checkTargets(installed), CHECK_CONCURRENCY, (target) =>
    checkAgent(target, settings.agentCmdOverrides).catch((error: unknown) => {
      console.warn(`[agent-updates] ${target.agent}: check failed`, error)
      return { row: null, latestFound: false }
    })
  )
  const lookups = checks.filter((check) => check !== null)
  return {
    rows: lookups.flatMap((check) => (check.row ? [check.row] : [])),
    sourcesReachable: lookups.length === 0 || lookups.some((check) => check.latestFound)
  }
}
