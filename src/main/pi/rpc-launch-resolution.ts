import { open, realpath } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { z } from 'zod'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleKey,
  type AgentSessionProviderHandleChain,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import {
  checkAgentCliVersion,
  type AgentCliVersionCheck,
  type AgentCliVersionReader
} from '../agent-cli-version-probe'
import { AgentCliInstallationError } from '../native-chat/agent-cli-installation-error'
import {
  resolveAgainAfterRefreshOnMissingProgram,
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation,
  resolveStructuredAgentCommand,
  type StructuredAgentCommand,
  type StructuredAgentCommandSettings
} from '../native-chat/structured-agent-command-resolution'
import type { StructuredAgentLaunchPartResolver } from '../runtime/structured-agent-launch-composition'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'
import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'
import {
  PI_RPC_SESSION_ENV_TO_DELETE,
  withoutPiCallerEnv,
  type PiRpcLaunchOptions
} from './rpc-launch'

export type PiRpcResolvedLaunch = PiRpcLaunchOptions & {
  previous: AgentSessionProviderHandleLink | null
  replacement?: 'unsaved' | 'restore-failed'
  /** Conversation files, newest first; empty for a new conversation. */
  lineage?: readonly string[]
}
export type PiRpcLaunchPartDeps = {
  resolveCommand?: typeof resolveCliCommand
  probeVersion?: AgentCliVersionReader
  resolveFullAccess?: () => boolean
}

// RPC turns require agent_settled (Pi 0.84+); older versions remain terminal-only.
export const PI_RPC_MINIMUM_VERSIONS = ['0.84.0'] as const

export function resolvePiRpcCommand(
  env: Readonly<Record<string, string>>,
  commandSettings: StructuredAgentCommandSettings = {},
  resolve?: typeof resolveCliCommand
): StructuredAgentCommand {
  const homePath = env.HOME ?? env.USERPROFILE
  return resolveStructuredAgentCommand(
    'pi',
    commandSettings,
    { pathEnv: env.PATH ?? env.Path ?? null, ...(homePath ? { homePath } : {}) },
    resolve ? { resolve } : {}
  )
}

export function checkPiRpcVersion(
  launch: {
    command: string
    prefixArgs?: readonly string[]
    cwd: string
    env: Record<string, string>
  },
  read?: AgentCliVersionReader
): Promise<AgentCliVersionCheck> {
  return checkAgentCliVersion(
    { program: launch.command, prefixArgs: launch.prefixArgs, cwd: launch.cwd, env: launch.env },
    PI_RPC_MINIMUM_VERSIONS,
    read
  )
}

const headerSchema = z.object({
  type: z.literal('session'),
  cwd: z.string().min(1),
  id: z.string().optional()
})

export async function readPiSessionHeader(
  file: string
): Promise<{ cwd: string; id?: string } | null> {
  let descriptor
  try {
    descriptor = await open(file, 'r')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await descriptor.read(buffer, 0, buffer.length, 0)
    const data = buffer.subarray(0, bytesRead).toString('utf8')
    const lf = data.indexOf('\n')
    if (lf === -1) {
      throw new Error('Pi session header is incomplete or oversized')
    }
    return headerSchema.parse(JSON.parse(data.slice(0, lf)))
  } finally {
    await descriptor.close()
  }
}

export async function samePiDirectory(left: string, right: string): Promise<boolean> {
  const canonical = async (value: string): Promise<string> =>
    realpath(value).catch(() => normalize(value))
  const [a, b] = await Promise.all([canonical(left), canonical(right)])
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Resolve chat/catalog launches identically; refresh the environment once if Pi is missing. */
export function resolvePiRpcInvocation(deps: {
  operation?: StructuredAgentResolutionOperation
  accountDir: string
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  commandSettings?: StructuredAgentCommandSettings
  resolveCommand?: typeof resolveCliCommand
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  /** Base for relative PATH entries; defaults to Orca's working directory. */
  resolveWorkingDirectory?: () => Promise<string> | string
}): Promise<StructuredAgentCommand & { env: Record<string, string> }> {
  return resolveAgainAfterRefreshOnMissingProgram(
    async () => {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(await deps.resolveEnvironment())) {
        if (value !== undefined) {
          env[key] = value
        }
      }
      assertStructuredAgentResolutionCurrent(deps.operation)
      env.PI_CODING_AGENT_DIR = deps.accountDir
      return { env, ...resolvePiRpcCommand(env, deps.commandSettings, deps.resolveCommand) }
    },
    deps.refreshEnvironmentAfterMiss,
    { env: ({ env }) => env, cwd: deps.resolveWorkingDirectory },
    deps.operation
  )
}

export function piRpcLaunchPart(
  deps: PiRpcLaunchPartDeps
): StructuredAgentLaunchPartResolver<PiRpcResolvedLaunch> {
  return async (basis) => {
    const { record } = basis
    if (process.platform === 'win32' && !isWindowsProcessStartTimeAvailable()) {
      throw new Error('Pi structured sessions require Windows process creation-time proof')
    }
    const accountHome = requireLegacyAgentSessionAccountHome(record.accountHome)
    const cwd = await basis.launchDirectory()
    const { env, command, prefixArgs } = await resolvePiRpcInvocation({
      accountDir: accountHome.path,
      resolveEnvironment: basis.environment,
      commandSettings: basis.commandSettings(),
      resolveCommand: deps.resolveCommand,
      refreshEnvironmentAfterMiss: basis.refreshAfterMissingProgram,
      resolveWorkingDirectory: () => cwd
    })
    const previous = agentSessionProviderHandleChainHead(record.providerHandleChain)
    let sessionFile: string | undefined
    let forkFile: string | undefined
    let replacement: PiRpcResolvedLaunch['replacement']
    if (previous) {
      if (
        previous.handle.transport !== 'jsonl-rpc' ||
        previous.handle.agent !== 'pi' ||
        !isAbsolute(previous.handle.nativeId)
      ) {
        throw new Error('Pi resume handle is not a host session file')
      }
      const source = previous.handle.nativeId
      const header = await readPiSessionHeader(source)
      if (
        previous.origin === 'adopted' &&
        (!header ||
          header.id !== sessionIdFromFileName(source) ||
          !(await samePiDirectory(header.cwd, cwd)))
      ) {
        throw agentSessionRefusalError('agent_session_identity_required', {
          reason: 'transcriptNotFound'
        })
      }
      if (header === null) {
        replacement = previous.origin === 'created' ? 'unsaved' : 'restore-failed'
      } else if (await samePiDirectory(header.cwd, cwd)) {
        sessionFile = source
      } else {
        forkFile = source
      }
    }
    // Recheck each launch because the PATH binary may have changed.
    const launchVersion = await checkPiRpcVersion(
      { command, prefixArgs, cwd, env },
      deps.probeVersion
    )
    if (launchVersion.status === 'tooOld') {
      throw AgentCliInstallationError.tooOld('pi', launchVersion)
    }
    return {
      launch: {
        command,
        prefixArgs,
        fullAccess: deps.resolveFullAccess?.() ?? true,
        previous,
        ...(sessionFile || forkFile
          ? { lineage: piConversationFiles(record.providerHandleChain) }
          : {}),
        ...(sessionFile ? { sessionFile } : {}),
        ...(forkFile ? { forkFile } : {}),
        ...(replacement ? { replacement } : {})
      },
      env: withoutPiCallerEnv(env),
      inheritedEnvToDelete: PI_RPC_SESSION_ENV_TO_DELETE
    }
  }
}

/** Follow resumes and directory forks to the original session; forks preserve entry IDs. */
function piConversationFiles(chain: AgentSessionProviderHandleChain): string[] {
  const files: string[] = []
  for (const link of chain.toReversed()) {
    if (link.handle.transport !== 'jsonl-rpc' || link.handle.agent !== 'pi') {
      break
    }
    files.push(link.handle.nativeId)
    if (link.origin !== 'resumed' && link.origin !== 'forked') {
      break
    }
  }
  return files
}

export function piRpcProviderLink(
  launch: PiRpcResolvedLaunch,
  file: string,
  fence: number,
  linkId: string,
  at: number
): AgentSessionProviderHandleLink {
  if (!isAbsolute(file)) {
    throw new Error('Pi did not return an absolute session file')
  }
  const previous = launch.previous
  if (launch.sessionFile && file !== launch.sessionFile) {
    throw new Error('Pi resumed a different session file')
  }
  if (launch.forkFile && file === launch.forkFile) {
    throw new Error('Pi did not fork the session for its new directory')
  }
  const key = previous ? agentSessionProviderHandleKey(previous.handle) : undefined
  return {
    linkId,
    handle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: file },
    origin: launch.forkFile ? 'forked' : launch.sessionFile ? 'resumed' : 'created',
    mintedAtFence: fence,
    observedAt: at,
    ...(launch.forkFile && key ? { forkedFromKey: key } : {}),
    ...(launch.replacement === 'unsaved' && key
      ? { supersedesKey: key, ...(previous?.replaces ? { replaces: previous.replaces } : {}) }
      : {}),
    ...(launch.replacement === 'restore-failed' && key
      ? { replaces: { key, reason: 'restore-failed', replacedAt: at } }
      : {})
  }
}
