import type {
  AgentHealthCheck,
  AgentHealthProvider,
  AgentHealthSnapshot,
  AgentHealthState,
  AgentUpdateAvailability,
  AgentUpdateResult
} from '../../shared/agent-health'
import { compareAppVersions, isValidAppVersion } from '../../shared/app-version'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveClaudeCommand, resolveCodexCommand } from '../../shared/node-cli-command-resolution'
import { buildLocalPreflightEnv } from './preflight-local-env'
import { getPreflightWslTarget, type PreflightRuntimeContext } from './preflight-runtime-target'
import { runPreflightCommandInWsl } from './preflight-wsl-command'
import { shellQuote, type PreflightCommandResult } from './preflight-command-exec'
import { resolveClaudeLatestVersion, type ClaudeUpdateChannel } from './agent-version-lookup'
import { parseCodexDoctorReport } from './agent-codex-doctor-report'

export { parseCodexDoctorChecks } from './agent-codex-doctor-report'

const AGENT_HEALTH_TIMEOUT_MS = 12_000
const AGENT_UPDATE_TIMEOUT_MS = 5 * 60_000
const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/

type CommandRunner = (
  provider: AgentHealthProvider,
  args: string[],
  context: PreflightRuntimeContext | undefined,
  timeoutMs: number
) => Promise<PreflightCommandResult>

type AgentCommandDependencies = {
  runCommand?: CommandRunner
  resolveClaudeVersion?: (channel: ClaudeUpdateChannel) => Promise<string | null>
}

function healthFromChecks(checks: readonly AgentHealthCheck[]): AgentHealthState {
  if (checks.some((check) => check.status === 'failed')) {
    return 'unhealthy'
  }
  if (checks.some((check) => check.status === 'warning')) {
    return 'degraded'
  }
  return checks.length > 0 ? 'healthy' : 'unknown'
}

function versionFromOutput(result: PreflightCommandResult): string | null {
  const line = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean)
  return line?.match(VERSION_PATTERN)?.[0] ?? null
}

function commandOutputFromError(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null
  }
  const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
  return stdout.trim() ? stdout : null
}

async function runLocalCommand(
  provider: AgentHealthProvider,
  args: string[],
  timeoutMs: number
): Promise<PreflightCommandResult> {
  const env = buildLocalPreflightEnv()
  const pathEnv = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path
  const command =
    provider === 'codex' ? resolveCodexCommand({ pathEnv }) : resolveClaudeCommand({ pathEnv })
  const result = await runProcess({ program: command, args, timeoutMs, ...(env ? { env } : {}) })
  if (result.timedOut || result.code !== 0) {
    throw Object.assign(new Error(`Agent command failed: ${command}`), result)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

async function runAgentCommand(
  provider: AgentHealthProvider,
  args: string[],
  context: PreflightRuntimeContext | undefined,
  timeoutMs: number
): Promise<PreflightCommandResult> {
  const wslTarget = getPreflightWslTarget(context)
  if (!wslTarget) {
    return runLocalCommand(provider, args, timeoutMs)
  }
  const command = [provider, ...args].map(shellQuote).join(' ')
  return runPreflightCommandInWsl(wslTarget, command, timeoutMs)
}

function updateAvailability(
  version: string | null,
  latestVersion: string | null
): AgentUpdateAvailability {
  if (
    !version ||
    !latestVersion ||
    !isValidAppVersion(version) ||
    !isValidAppVersion(latestVersion)
  ) {
    return 'unknown'
  }
  return compareAppVersions(version, latestVersion) < 0 ? 'available' : 'current'
}

function claudeUpdateChannel(result: PreflightCommandResult | null): ClaudeUpdateChannel {
  return result?.stdout.trim() === 'stable' ? 'stable' : 'latest'
}

async function probeUpdateSupport(
  provider: AgentHealthProvider,
  context: PreflightRuntimeContext | undefined,
  runCommand: CommandRunner,
  availability: AgentUpdateAvailability
): Promise<boolean | undefined> {
  if (availability !== 'available') {
    return undefined
  }
  try {
    await runCommand(provider, ['update', '--help'], context, AGENT_HEALTH_TIMEOUT_MS)
    return true
  } catch {
    return false
  }
}

async function probeProvider(
  provider: AgentHealthProvider,
  context: PreflightRuntimeContext | undefined,
  runCommand: CommandRunner,
  resolveClaudeVersion: (channel: ClaudeUpdateChannel) => Promise<string | null>
): Promise<AgentHealthSnapshot> {
  let codexReport: ReturnType<typeof parseCodexDoctorReport> = null
  if (provider === 'codex') {
    let doctorOutput: string | null = null
    try {
      doctorOutput = (
        await runCommand(provider, ['doctor', '--json'], context, AGENT_HEALTH_TIMEOUT_MS)
      ).stdout
    } catch (error) {
      doctorOutput = commandOutputFromError(error)
    }
    codexReport = doctorOutput ? parseCodexDoctorReport(doctorOutput) : null
  }

  let version = codexReport?.currentVersion ?? null
  try {
    if (!version) {
      version = versionFromOutput(
        await runCommand(provider, ['--version'], context, AGENT_HEALTH_TIMEOUT_MS)
      )
    }
  } catch {
    return {
      provider,
      cliStatus: 'unavailable',
      health: 'unhealthy',
      version: null,
      checks: [{ id: 'cli', status: 'failed' }],
      latestVersion: null,
      updateAvailability: 'unknown',
      updateSupported: false
    }
  }

  const checks: AgentHealthCheck[] = [{ id: 'cli', status: 'ok' }]
  if (provider === 'codex') {
    if (codexReport) {
      checks.push(...codexReport.checks)
    }
    const latestVersion = codexReport?.latestVersion ?? null
    const availability = updateAvailability(version, latestVersion)
    const updateSupported = await probeUpdateSupport(provider, context, runCommand, availability)
    return {
      provider,
      cliStatus: 'available',
      health: codexReport ? healthFromChecks(checks) : 'unknown',
      version,
      checks,
      latestVersion,
      updateAvailability: availability,
      ...(updateSupported === undefined ? {} : { updateSupported })
    }
  }

  const channelResult = await runCommand(
    provider,
    ['config', 'get', 'autoUpdatesChannel'],
    context,
    AGENT_HEALTH_TIMEOUT_MS
  ).catch(() => null)
  const latestVersion = await resolveClaudeVersion(claudeUpdateChannel(channelResult)).catch(
    () => null
  )
  const availability = updateAvailability(version, latestVersion)
  const updateSupported = await probeUpdateSupport(provider, context, runCommand, availability)
  return {
    provider,
    cliStatus: 'available',
    health: healthFromChecks(checks),
    version,
    checks,
    latestVersion,
    updateAvailability: availability,
    ...(updateSupported === undefined ? {} : { updateSupported })
  }
}

export function probeAgentHealth(
  context?: PreflightRuntimeContext,
  dependencies: AgentCommandDependencies = {}
): Promise<AgentHealthSnapshot[]> {
  return Promise.all(
    (['claude', 'codex'] as const).map((provider) =>
      probeAgentProviderHealth(provider, context, dependencies)
    )
  )
}

export function probeAgentProviderHealth(
  provider: AgentHealthProvider,
  context?: PreflightRuntimeContext,
  dependencies: AgentCommandDependencies = {}
): Promise<AgentHealthSnapshot> {
  const runCommand = dependencies.runCommand ?? runAgentCommand
  const resolveClaudeVersion = dependencies.resolveClaudeVersion ?? resolveClaudeLatestVersion
  return probeProvider(provider, context, runCommand, resolveClaudeVersion)
}

export async function updateAgent(
  provider: AgentHealthProvider,
  context?: PreflightRuntimeContext,
  dependencies: AgentCommandDependencies = {}
): Promise<AgentUpdateResult> {
  const runCommand = dependencies.runCommand ?? runAgentCommand
  const before = versionFromOutput(
    await runCommand(provider, ['--version'], context, AGENT_HEALTH_TIMEOUT_MS)
  )
  if (!before) {
    throw new Error('Agent version unavailable before update')
  }
  await runCommand(provider, ['update'], context, AGENT_UPDATE_TIMEOUT_MS)
  const after = versionFromOutput(
    await runCommand(provider, ['--version'], context, AGENT_HEALTH_TIMEOUT_MS)
  )
  if (!after) {
    throw new Error('Agent version unavailable after update')
  }
  return {
    provider,
    outcome: before === after ? 'current' : 'updated',
    previousVersion: before,
    currentVersion: after
  }
}
