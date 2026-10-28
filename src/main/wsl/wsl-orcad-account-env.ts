import { CODEX_STORE_OVERLAY_RUNTIME_CAPABILITY } from '../../shared/account-runtime-capabilities'
/** D10: desktop prepares distro-local account homes for orcad. Patch caller-built launches/plain shells, agent.launch accountEnv, and capability-advertised agent-session creates; leave bare-command Settings defaults untouched. */
import { errorMessage } from '../../shared/error-message'
import { posix } from 'node:path'
import {
  AGENT_LAUNCH_ACCOUNT_ENV_KEYS,
  AgentLaunchAccountEnv
} from '../../shared/agent-launch-account-env'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth/runtime-auth-types'
import { AGENT_SESSION_ACCOUNT_ENV_RUNTIME_CAPABILITY } from '../../shared/agent-session-create-capabilities'
import {
  wslOrcadHostDistro,
  type WslOrcadHostCapabilityVerdict
} from './wsl-orcad-host-environments'

export type WslAccountTarget = { runtime: 'wsl'; wslDistro: string }

export type WslOrcadAccountEnvDependencies = {
  /** `ClaudeRuntimeAuthService.prepareForClaudeLaunch`: waits for a first account setup. */
  prepareClaudeLaunch(target: WslAccountTarget): Promise<ClaudeRuntimeAuthPreparation>
  /** The pointer-only env a non-Claude pane gets, so a typed `claude` still follows the account. */
  claudeTerminalEnv(target: WslAccountTarget): Record<string, string>
  /** The selected Codex account's home (a UNC or guest path); null on System default. */
  prepareCodexHome(target: WslAccountTarget): Promise<string | null>
  /** Whether an Orca-managed Claude or Codex account is selected for the distro. */
  managedAccountSelected(target: WslAccountTarget): boolean
  /** Tells the user the selected account was not applied: the distro's orcad predates it. */
  accountNotApplied(distro: string): void
}

let installed: WslOrcadAccountEnvDependencies | null = null

export function installWslOrcadAccountEnvDependencies(
  dependencies: WslOrcadAccountEnvDependencies | null
): void {
  installed = dependencies
}

export function getWslOrcadAccountEnvDependencies(): WslOrcadAccountEnvDependencies | null {
  return installed
}

export class WslOrcadAccountEnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WslOrcadAccountEnvError'
  }
}

export function distroTarget(distro: string): WslAccountTarget {
  return { runtime: 'wsl', wslDistro: distro }
}

function sameDistro(a: string | null | undefined, b: string): boolean {
  return a?.trim().toLowerCase() === b.trim().toLowerCase()
}

function accountKeysOf(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of AGENT_LAUNCH_ACCOUNT_ENV_KEYS) {
    const value = env[key]
    if (value) {
      picked[key] = value
    }
  }
  return picked
}

/** The guest path of a Codex home; null when it belongs to another distro. */
export function guestCodexHomePath(home: string, distro: string): string | null {
  const unc = parseWslUncPath(home)
  if (unc) {
    return sameDistro(unc.distro, distro) ? unc.linuxPath : null
  }
  return home.startsWith('/') ? posix.normalize(home) : null
}

/** The account env for one process started in `distro`; `agent` null is a plain shell. */
export async function prepareWslOrcadAccountEnv(
  distro: string,
  agent: TuiAgent | null,
  dependencies: WslOrcadAccountEnvDependencies
): Promise<Record<string, string>> {
  const target = distroTarget(distro)
  const env: Record<string, string> = {}
  if (agent === 'claude') {
    const preparation = await dependencies.prepareClaudeLaunch(target)
    // Off-Windows account services route WSL targets to the host; accept patches only from the matching distro.
    if (preparation.runtime === 'wsl' && sameDistro(preparation.wslDistro, distro)) {
      Object.assign(env, accountKeysOf(preparation.envPatch))
    }
  } else {
    Object.assign(env, accountKeysOf(dependencies.claudeTerminalEnv(target)))
  }
  const codexHome = await dependencies.prepareCodexHome(target)
  const guestHome = codexHome ? guestCodexHomePath(codexHome, distro) : null
  if (guestHome) {
    // Do not mark ORCA_CODEX_HOME: orcad strips CODEX_HOME when they match.
    env.CODEX_HOME = guestHome
  }
  const checked = AgentLaunchAccountEnv.safeParse(env)
  if (!checked.success) {
    throw new WslOrcadAccountEnvError('The selected account folder in WSL is not a usable path.')
  }
  return checked.data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringRecord(value: unknown): Record<string, string> {
  const record: Record<string, string> = {}
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') {
        record[key] = entry
      }
    }
  }
  return record
}

function tuiAgentOf(value: unknown): TuiAgent | null {
  return isTuiAgent(value) ? value : null
}

type EnvPatchPlan = {
  field: 'env' | 'accountEnv'
  agent: TuiAgent | null
  /** Set when the host refuses an unknown field, so only an advertising host gets it. */
  capability?: typeof AGENT_SESSION_ACCOUNT_ENV_RUNTIME_CAPABILITY
}

/** Null leaves the call untouched. */
function envPatchPlan(method: string, params: Record<string, unknown>): EnvPatchPlan | null {
  if (method === 'agent.launch' || method === 'agent.launchReplay') {
    // A reused terminal starts no process, so it has no home to choose.
    return params.reuseTerminal ? null : { field: 'accountEnv', agent: tuiAgentOf(params.agent) }
  }
  if (
    method === 'terminal.createAgentSession' ||
    (method === 'terminal.ensureAgentSession' && params.kind === 'explicit')
  ) {
    return {
      field: 'accountEnv',
      agent: tuiAgentOf(params.agent),
      capability: AGENT_SESSION_ACCOUNT_ENV_RUNTIME_CAPABILITY
    }
  }
  if (method !== 'terminal.create' && method !== 'session.tabs.createTerminal') {
    return null
  }
  const launchAgent = tuiAgentOf(params.launchAgent)
  const callerBuiltLaunch =
    params.env !== undefined || params.launchConfig !== undefined || launchAgent !== null
  const plainShell = params.command === undefined && params.agent === undefined
  return callerBuiltLaunch || plainShell ? { field: 'env', agent: launchAgent } : null
}

export type WslOrcadAccountEnvResult =
  | { ok: true; params: unknown }
  | { ok: false; message: string }

export type WslOrcadAccountEnvCall = {
  environmentId: string
  method: string
  params: unknown
  /** Whether the host behind `environmentId` advertises `capability`. */
  hostSupports: (capability: string) => Promise<WslOrcadHostCapabilityVerdict>
}

/** `params` with the account env of the WSL distro behind `environmentId`; as is for any other. */
export async function withWslOrcadAccountEnv(
  call: WslOrcadAccountEnvCall,
  dependencies: WslOrcadAccountEnvDependencies | null = installed,
  distroOf: (environmentId: string) => string | null = wslOrcadHostDistro
): Promise<WslOrcadAccountEnvResult> {
  const { params } = call
  const distro = distroOf(call.environmentId)
  const plan = distro && dependencies && isRecord(params) ? envPatchPlan(call.method, params) : null
  if (!plan || !distro || !dependencies || !isRecord(params)) {
    return { ok: true, params }
  }
  if (plan.capability) {
    const verdict = await call.hostSupports(plan.capability)
    if (verdict !== 'supported') {
      // Older hosts historically use their default account; warn rather than refuse.
      if (verdict === 'unsupported' && dependencies.managedAccountSelected(distroTarget(distro))) {
        dependencies.accountNotApplied(distro)
      }
      return { ok: true, params }
    }
  }
  let env: Record<string, string>
  try {
    env = await prepareWslOrcadAccountEnv(distro, plan.agent, dependencies)
  } catch (error) {
    // Preparation failure must refuse launch or it would silently use another account.
    return { ok: false, message: errorMessage(error) }
  }
  // Older servers retain the account-home route and never receive an overlay path.
  if (
    env.CODEX_HOME &&
    posix.basename(posix.dirname(env.CODEX_HOME)) === 'overlays' &&
    (await call.hostSupports(CODEX_STORE_OVERLAY_RUNTIME_CAPABILITY)) !== 'supported'
  ) {
    env.CODEX_HOME = posix.join(posix.dirname(posix.dirname(env.CODEX_HOME)), 'home')
  }
  if (Object.keys(env).length === 0) {
    return { ok: true, params }
  }
  if (plan.field === 'accountEnv') {
    return { ok: true, params: { ...params, accountEnv: env } }
  }
  return { ok: true, params: { ...params, env: { ...stringRecord(params.env), ...env } } }
}
