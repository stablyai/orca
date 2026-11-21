import { Readable } from 'node:stream'
import {
  getAgentModelProbeSpec,
  type AgentModelProbeSpec
} from '../../../../shared/agent-session/options/model-catalog/agent-model-probe-spec'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { SshRemotePlatform } from '../../../../shared/remote-runtime/ssh/ssh-types'
import { overlayEnvironmentVariables } from '../../../../shared/shell/launch/environment-overlay'
import type { CommandTemplateBackslash } from '../../../../shared/source-control/ai/generation/commit-message-prompt'
import {
  runClaudeBackgroundAttempts,
  type ClaudeBackgroundFailedExit
} from '../../../../shared/text-generation/launch/claude-background-run-isolation'
import { getRemoteHostPlatform } from '../../../ssh/remote-host/ssh-remote-platform'
import { captureHostCommand } from '../../../ssh/remote-exec/remote-host-exec'
import {
  getRegisteredSshState,
  getSshConnectionManager
} from '../../../ssh/targets/ssh-target-registry'
import { isSshExecTimeout } from '../../../ssh/remote-exec/remote-exec-command'
import {
  buildPosixModelProbeCommand,
  buildWindowsModelProbeCommand
} from './ssh-model-probe-command'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from '../../../text-generation/execution/source-control-generation-limits'
import {
  finalizeModelDiscoveryOutput,
  planModelDiscovery,
  safeProbeErrorLog
} from '../../../text-generation/models/commit-message-model-discovery-policy'
import type { DiscoverCommitMessageModelsResult } from '../../../text-generation/source-control-text-generation-types'

export type RemoteModelProbe =
  | { stdout: string; stderr: string; code: number | null }
  | { error: string }

type ProbeConnection = Parameters<typeof captureHostCommand>[0] & {
  getState(): { status: string }
}

export type SshModelProbeHooks = {
  remotePlatform?: (connectionId: string) => SshRemotePlatform | undefined
  connection?: (connectionId: string) => ProbeConnection | undefined
}

export function sshProbeIsWindows(connectionId: string, hooks?: SshModelProbeHooks): boolean {
  const platform =
    hooks?.remotePlatform?.(connectionId) ?? getRegisteredSshState(connectionId)?.remotePlatform
  return platform === 'win32'
}

/** Runs one remote command with the dialect wrapper, bounded output, and stderr errors from exec. */
export async function runSshModelProbe(
  connectionId: string,
  command: string,
  stdin: string | null,
  hooks?: SshModelProbeHooks
): Promise<RemoteModelProbe> {
  const connection =
    hooks?.connection?.(connectionId) ?? getSshConnectionManager()?.getConnection(connectionId)
  if (connection?.getState().status !== 'connected') {
    return { error: `SSH target "${connectionId}" is not connected.` }
  }
  const host = getRemoteHostPlatform(
    sshProbeIsWindows(connectionId, hooks) ? 'win32-x64' : 'linux-x64'
  )
  try {
    return await captureHostCommand(connection, host, command, {
      timeoutMs: SOURCE_CONTROL_GENERATION_TIMEOUT_MS,
      stdin: stdin === null ? undefined : Readable.from([Buffer.from(stdin)])
    })
  } catch (error) {
    return { error: sshProbeFailure(connectionId, error) }
  }
}

/** Timeout and transport failures name the host. Errno codes are safe; message text is not. */
function sshProbeFailure(connectionId: string, error: unknown): string {
  if (isSshExecTimeout(error)) {
    return `SSH target "${connectionId}" timed out while listing models.`
  }
  const code = safeProbeErrorLog(error).code
  return typeof code === 'string'
    ? `SSH model discovery transport failed (${code}).`
    : 'SSH model discovery transport failed.'
}

export function discoverModelsOverSsh(input: {
  agentId: TuiAgent
  cwd: string
  connectionId: string
  env?: NodeJS.ProcessEnv
  agentCommandOverride?: string
  windows: boolean
  runRemoteProbe: (
    connectionId: string,
    command: string,
    stdin: string | null
  ) => Promise<RemoteModelProbe>
}): Promise<DiscoverCommitMessageModelsResult> {
  const spec = getAgentModelProbeSpec(input.agentId)
  if (!spec?.modelDiscovery) {
    return Promise.resolve({
      success: false,
      error: `Agent "${input.agentId}" does not support model discovery.`
    })
  }
  if ('listing' in spec.modelDiscovery) {
    return Promise.resolve({
      success: false,
      error: `${spec.label} model discovery is unavailable on SSH host "${input.connectionId}".`
    })
  }
  const backslash: CommandTemplateBackslash = input.windows ? 'literal' : 'escape'
  return runClaudeBackgroundAttempts({
    agentId: input.agentId,
    run: (strictMcp) => probeSshModels(input, spec, backslash, strictMcp),
    failedExit: (outcome) => (outcome.result.success ? undefined : outcome.failedExit)
  }).then((attempt) => attempt.result)
}

async function probeSshModels(
  input: {
    cwd: string
    connectionId: string
    env?: NodeJS.ProcessEnv
    agentCommandOverride?: string
    windows: boolean
    runRemoteProbe: (
      connectionId: string,
      command: string,
      stdin: string | null
    ) => Promise<RemoteModelProbe>
  },
  spec: AgentModelProbeSpec,
  backslash: CommandTemplateBackslash,
  strictMcp: boolean
): Promise<{
  result: DiscoverCommitMessageModelsResult
  failedExit?: ClaudeBackgroundFailedExit
}> {
  const planned = planModelDiscovery(spec, input.agentCommandOverride, backslash, strictMcp)
  if (!planned.ok) {
    return { result: { success: false, error: planned.error } }
  }
  const plan = { ...planned.plan, ...probePlanEnv(input.env, planned.plan.env, input.windows) }
  const posixProbe = input.windows ? undefined : buildPosixModelProbeCommand(input.cwd, plan)
  const command = posixProbe ? posixProbe.command : buildWindowsModelProbeCommand(input.cwd, plan)
  const probed = await input.runRemoteProbe(input.connectionId, command, planned.plan.stdinPayload)
  if ('error' in probed) {
    return { result: { success: false, error: probed.error } }
  }
  // execCommandOnce already removed its own fence. This one removes the login profile banner
  // that printed inside that capture, and keeps an injected probe's unfenced stdout.
  const stdout = posixProbe ? posixProbe.readStdout(probed.stdout) : probed.stdout
  const failedExit =
    probed.code === 0 ? undefined : { exitCode: probed.code, stdout, stderr: probed.stderr }
  return {
    result: finalizeModelDiscoveryOutput(spec, stdout, probed.stderr, probed.code),
    ...(failedExit ? { failedExit } : {})
  }
}

function probePlanEnv(
  base: NodeJS.ProcessEnv | undefined,
  overrides: Record<string, string> | undefined,
  windows: boolean
): { env: Record<string, string> } | undefined {
  const baseEntries = Object.entries(base ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
  const env = overrides
    ? overlayEnvironmentVariables(
        Object.fromEntries(baseEntries),
        overrides,
        windows ? 'win32' : 'linux'
      )
    : Object.fromEntries(baseEntries)
  return Object.keys(env).length > 0 ? { env } : undefined
}
