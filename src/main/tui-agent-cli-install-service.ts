import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TuiAgent } from '../shared/types'
import {
  getAgentInstallCommand,
  getAgentInstallVerifyCommand,
  isInstallableTuiAgent,
  toAgentInstallPlatform,
  type AgentInstallPlatform
} from '../shared/tui-agent-install-commands'
import { isCommandOnPath } from './ipc/preflight-command-exec'
import { hydrateShellPathForAgentDetection } from './ipc/agent-detection-shell-path'

const execFileAsync = promisify(execFile)

// Why: agent installers download packages over the network; keep this well above
// preflight's 5s probe timeout but bounded so a hung curl/npm cannot pin the RPC forever.
export const AGENT_CLI_INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const MAX_ERROR_CHARS = 800

export type AgentCliInstallStatus = 'installed' | 'already_present' | 'failed' | 'unsupported'

export type AgentCliInstallResult = {
  agent: TuiAgent
  status: AgentCliInstallStatus
  message?: string
}

export type AgentCliInstallRunDeps = {
  platform?: NodeJS.Platform
  isCommandOnPath?: (command: string) => Promise<boolean>
  runInstallCommand?: (
    command: string,
    platform: AgentInstallPlatform
  ) => Promise<{ stdout: string; stderr: string }>
  hydrateShellPath?: () => Promise<void>
}

function truncateErrorOutput(value: string): string {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= MAX_ERROR_CHARS) {
    return trimmed
  }
  return `${trimmed.slice(0, MAX_ERROR_CHARS - 1)}…`
}

function formatInstallError(error: unknown): string {
  if (!(error instanceof Error)) {
    return truncateErrorOutput(String(error))
  }
  const withOutput = error as Error & { stdout?: string; stderr?: string; code?: string | number }
  const details = [withOutput.stderr, withOutput.stdout, withOutput.message]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' | ')
  return truncateErrorOutput(details || 'Install failed.')
}

export async function runAgentInstallShellCommand(
  command: string,
  platform: AgentInstallPlatform
): Promise<{ stdout: string; stderr: string }> {
  if (platform === 'win32') {
    return (await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        encoding: 'utf-8',
        timeout: AGENT_CLI_INSTALL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
      }
    )) as { stdout: string; stderr: string }
  }

  return (await execFileAsync('/bin/bash', ['-lc', command], {
    encoding: 'utf-8',
    timeout: AGENT_CLI_INSTALL_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env
  })) as { stdout: string; stderr: string }
}

export async function installTuiAgentClis(
  agents: readonly string[],
  deps: AgentCliInstallRunDeps = {}
): Promise<{ results: AgentCliInstallResult[] }> {
  const platform = toAgentInstallPlatform(deps.platform ?? process.platform)
  if (!platform) {
    return {
      results: agents.filter(isInstallableTuiAgent).map((agent) => ({
        agent,
        status: 'unsupported' as const,
        message: `Install is not supported on platform ${deps.platform ?? process.platform}.`
      }))
    }
  }

  const hydrate =
    deps.hydrateShellPath ??
    (async () => {
      await hydrateShellPathForAgentDetection()
    })
  const checkPath = deps.isCommandOnPath ?? ((command: string) => isCommandOnPath(command))
  const runCommand = deps.runInstallCommand ?? runAgentInstallShellCommand

  await hydrate()

  const results: AgentCliInstallResult[] = []
  for (const agentId of agents) {
    if (!isInstallableTuiAgent(agentId)) {
      continue
    }
    const command = getAgentInstallCommand(agentId, platform)
    if (!command) {
      results.push({
        agent: agentId,
        status: 'unsupported',
        message: `No unattended installer is available for ${agentId} on ${platform}.`
      })
      continue
    }

    const verifyCmd = getAgentInstallVerifyCommand(agentId)
    if (await checkPath(verifyCmd)) {
      results.push({ agent: agentId, status: 'already_present' })
      continue
    }

    try {
      await runCommand(command, platform)
      // Why: installers often append to PATH via shell rc files or user dirs;
      // re-hydrate before verifying so the same process can see the new binary.
      await hydrate()
      if (await checkPath(verifyCmd)) {
        results.push({ agent: agentId, status: 'installed' })
      } else {
        results.push({
          agent: agentId,
          status: 'failed',
          message: `Install finished but ${verifyCmd} is still not on PATH. Open a new shell or check the installer output.`
        })
      }
    } catch (error) {
      results.push({
        agent: agentId,
        status: 'failed',
        message: formatInstallError(error)
      })
    }
  }

  return { results }
}
