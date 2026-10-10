import { open, realpath } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { z } from 'zod'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleKey,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { isStableCliVersionOnLine, probeAgentCliVersion } from '../agent-cli-version-probe'
import {
  resolveStructuredAgentCommand,
  type StructuredAgentCommandSettings
} from '../native-chat/structured-agent-command-resolution'
import type { StructuredAgentLaunchPartResolver } from '../runtime/structured-agent-launch-composition'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'
import {
  PI_RPC_SESSION_ENV_TO_DELETE,
  withoutPiCallerEnv,
  type PiRpcLaunchOptions
} from './rpc-launch'

export type PiRpcResolvedLaunch = PiRpcLaunchOptions & {
  previous: AgentSessionProviderHandleLink | null
  replacement?: 'unsaved' | 'restore-failed'
}
export type PiRpcLaunchPartDeps = {
  resolveCommand?: typeof resolveCliCommand
  probeVersion?: typeof probeAgentCliVersion
  resolveFullAccess?: () => boolean
}

// Stable releases from 0.84.0 emit agent_settled after retries and detached compaction; older
// Pi (the 0.73.x package included) keeps the terminal chat.
const PI_RPC_RELEASE_LINES = [
  { major: 0, floor: '0.84.0' },
  { major: 1, floor: '1.0.0' }
] as const

function supportsPiRpcVersion(version: string): boolean {
  return PI_RPC_RELEASE_LINES.some((line) => isStableCliVersionOnLine(version, line))
}

/** The binary a Pi launch with `env` spawns; create support resolves through here too. */
export function resolvePiRpcCommand(
  env: Readonly<Record<string, string>>,
  commandSettings: StructuredAgentCommandSettings = {},
  resolve?: typeof resolveCliCommand
): string {
  const homePath = env.HOME ?? env.USERPROFILE
  return resolveStructuredAgentCommand(
    'pi',
    commandSettings,
    { pathEnv: env.PATH ?? env.Path ?? null, ...(homePath ? { homePath } : {}) },
    resolve ? { resolve } : {}
  )
}

export function piRpcVersionSupported(
  launch: { command: string; cwd: string; env: Record<string, string> },
  probe: typeof probeAgentCliVersion = probeAgentCliVersion
): Promise<boolean> {
  return probe({ program: launch.command, cwd: launch.cwd, env: launch.env }, supportsPiRpcVersion)
}

const headerSchema = z.object({ type: z.literal('session'), cwd: z.string().min(1) })

async function sessionDirectory(file: string): Promise<string | null> {
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
    return headerSchema.parse(JSON.parse(data.slice(0, lf))).cwd
  } finally {
    await descriptor.close()
  }
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  const canonical = async (value: string): Promise<string> =>
    realpath(value).catch(() => normalize(value))
  const [a, b] = await Promise.all([canonical(left), canonical(right)])
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Pi's part of a launch: its account directory, session file or fork, binary and release check. */
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
    const env: Record<string, string> = {
      ...(await basis.environment()),
      PI_CODING_AGENT_DIR: accountHome.path
    }
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
      const directory = await sessionDirectory(source)
      if (directory === null) {
        replacement = previous.origin === 'created' ? 'unsaved' : 'restore-failed'
      } else if (await sameDirectory(directory, cwd)) {
        sessionFile = source
      } else {
        forkFile = source
      }
    }
    const command = resolvePiRpcCommand(env, basis.commandSettings(), deps.resolveCommand)
    // Again at every launch: the binary on PATH may have changed since the chat was created.
    if (!(await piRpcVersionSupported({ command, cwd, env }, deps.probeVersion))) {
      throw agentSessionRefusalError('structured_agent_session_unsupported', {
        reason: 'hostUnsupported'
      })
    }
    return {
      launch: {
        command,
        fullAccess: deps.resolveFullAccess?.() ?? true,
        previous,
        ...(sessionFile ? { sessionFile } : {}),
        ...(forkFile ? { forkFile } : {}),
        ...(replacement ? { replacement } : {})
      },
      env: withoutPiCallerEnv(env),
      inheritedEnvToDelete: PI_RPC_SESSION_ENV_TO_DELETE
    }
  }
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
