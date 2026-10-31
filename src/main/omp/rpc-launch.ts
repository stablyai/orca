import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { checkAgentCliVersion } from '../agent-cli-version-probe'
import { AgentCliInstallationError } from '../native-chat/agent-cli-installation-error'
import { SESSION_FILE_ID_LAYOUTS } from '../native-chat/session-file-id-layouts'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import {
  agentSessionProviderHandleChainHead,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import {
  assertStructuredAgentResolutionCurrent,
  resolveAgainAfterRefreshOnMissingProgram,
  resolveStructuredAgentCommand,
  type StructuredAgentCommand,
  type StructuredAgentCommandSettings,
  type StructuredAgentResolutionOperation
} from '../native-chat/structured-agent-command-resolution'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'
import type { StructuredAgentLaunchPartResolver } from '../runtime/structured-agent-launch-composition'
import {
  piRpcProviderLink,
  readPiSessionHeader,
  samePiDirectory,
  type PiRpcResolvedLaunch
} from '../pi/rpc-launch-resolution'
import {
  buildPiRpcLaunch,
  PI_RPC_SESSION_ENV_TO_DELETE,
  withoutPiCallerEnv,
  type PiRpcLaunchOptions
} from '../pi/rpc-launch'
import { resolveOmpSessionsDir } from '../ai-vault/omp-session-root'
import { findOmpSessionByCwd } from './omp-session-cwd-lookup'

export const OMP_RPC_MINIMUM_VERSIONS = ['18.4.5'] as const

export function resolveOmpRpcCommand(
  env: Readonly<Record<string, string>>,
  settings: StructuredAgentCommandSettings = {}
): StructuredAgentCommand {
  return resolveStructuredAgentCommand('omp', settings, {
    pathEnv: env.PATH ?? env.Path ?? null,
    homePath: env.HOME ?? env.USERPROFILE
  })
}

export function resolveOmpRpcInvocation(input: {
  accountDir: string
  environment: () => Promise<Record<string, string>>
  settings: StructuredAgentCommandSettings
  cwd: string
  refreshAfterMiss?: (askedAt: number) => Promise<void>
  operation?: StructuredAgentResolutionOperation
}): Promise<StructuredAgentCommand & { env: Record<string, string> }> {
  return resolveAgainAfterRefreshOnMissingProgram(
    async () => {
      const env = withoutPiCallerEnv({
        ...(await input.environment()),
        PI_CODING_AGENT_DIR: input.accountDir
      })
      assertStructuredAgentResolutionCurrent(input.operation)
      return { env, ...resolveOmpRpcCommand(env, input.settings) }
    },
    input.refreshAfterMiss,
    { env: (resolved) => resolved.env, cwd: () => input.cwd, signal: input.operation?.signal },
    input.operation
  )
}

export const ompRpcProviderLink: typeof piRpcProviderLink = (launch, ...args) => {
  const link = piRpcProviderLink(launch, ...args)
  const previous = launch.previous?.handle
  return {
    ...link,
    // Keep a saved chat's immutable identity namespace while using RPC to open its transcript.
    handle:
      previous?.agent === 'omp' && previous.transport === 'acp'
        ? { ...previous }
        : { ...link.handle, agent: 'omp' }
  }
}

export function buildOmpRpcLaunch(
  options: PiRpcLaunchOptions
): ReturnType<typeof buildPiRpcLaunch> {
  const launch = buildPiRpcLaunch({ ...options, fullAccess: true })
  const modeIndex = (options.prefixArgs?.length ?? 0) + 1
  return {
    ...launch,
    args: launch.args.map((arg, index) => (index === modeIndex ? 'rpc-ui' : arg))
  }
}

/** Resolve both native RPC handles and legacy OMP ACP handles to the JSONL file RPC can resume. */
export async function resolveOmpRpcResume(input: {
  previous: AgentSessionProviderHandleLink
  cwd: string
  env: Record<string, string>
  priorLineage?: readonly string[]
}): Promise<{ sessionFile: string; lineage: readonly string[] }> {
  const { previous, cwd, env } = input
  if (previous.handle.agent !== 'omp') {
    throw new Error('OMP resume handle belongs to a different agent')
  }
  let sessionFile: string
  if (previous.handle.transport === 'jsonl-rpc') {
    if (!isAbsolute(previous.handle.nativeId)) {
      throw new Error('OMP resume requires an RPC session file')
    }
    sessionFile = previous.handle.nativeId
  } else if (previous.handle.transport === 'acp') {
    const homeDir = env.USERPROFILE ?? env.HOME ?? homedir()
    const sessionsDir = resolveOmpSessionsDir({ env, homeDir })
    const found = await findOmpSessionByCwd({
      sessionsDir,
      sessionId: previous.handle.nativeId,
      cwd,
      homeDir,
      env,
      strictErrors: true
    })
    if (!found) {
      throw new Error(
        'OMP ACP session transcript is missing; create a new chat or restore the session file'
      )
    }
    sessionFile = found
  } else {
    throw new Error('OMP resume handle uses an unsupported transport')
  }
  const header = await readPiSessionHeader(sessionFile, { titleSlot: true })
  if (!header) {
    throw new Error('OMP session file is missing; create a new chat or restore the session file')
  }
  if (
    !header.id ||
    !SESSION_FILE_ID_LAYOUTS.omp.fileMatchesId(sessionFile, header.id) ||
    (previous.handle.transport === 'acp' && header.id !== previous.handle.nativeId)
  ) {
    throw new Error('OMP session file identity does not match its handle')
  }
  if (!(await samePiDirectory(header.cwd, cwd))) {
    throw new Error('OMP session belongs to a different working directory')
  }
  const lineage = new Set(
    [...(input.priorLineage ?? []), previous.handle.nativeId, sessionFile].filter(
      (value) => value.trim().length > 0
    )
  )
  return { sessionFile, lineage: [...lineage] }
}

export function ompRpcLaunchPart(
  stateDirectory: string
): StructuredAgentLaunchPartResolver<PiRpcResolvedLaunch> {
  return async (basis) => {
    const { record } = basis
    if (process.platform === 'win32' && !isWindowsProcessStartTimeAvailable()) {
      throw new Error('OMP structured sessions require Windows process creation-time proof')
    }
    const account = requireLegacyAgentSessionAccountHome(record.accountHome)
    const cwd = await basis.launchDirectory()
    const { env, command, prefixArgs } = await resolveOmpRpcInvocation({
      accountDir: account.path,
      environment: basis.environment,
      settings: basis.commandSettings(),
      cwd,
      refreshAfterMiss: basis.refreshAfterMissingProgram
    })
    const version = await checkAgentCliVersion(
      { program: command, prefixArgs, cwd, env },
      OMP_RPC_MINIMUM_VERSIONS
    )
    if (version.status === 'tooOld') {
      throw AgentCliInstallationError.tooOld('omp', version)
    }
    const previous = agentSessionProviderHandleChainHead(record.providerHandleChain)
    let sessionFile: string | undefined
    let lineage: readonly string[] | undefined
    if (previous) {
      const resolved = await resolveOmpRpcResume({
        previous,
        cwd,
        env,
        priorLineage: record.providerHandleChain.map((link) => link.handle.nativeId)
      })
      sessionFile = resolved.sessionFile
      lineage = resolved.lineage
    }
    const overlay = join(stateDirectory, 'omp-rpc', 'goal.yml')
    await mkdir(join(stateDirectory, 'omp-rpc'), { recursive: true })
    await writeFile(
      overlay,
      'goal:\n  continuationModes: [interactive, rpc]\nask:\n  timeout: 0\n',
      {
        mode: 0o600,
        flag: 'wx'
      }
    ).catch((error) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    })
    return {
      launch: {
        command,
        prefixArgs,
        fullAccess: true,
        previous,
        extraArgs: [...(record.launchArgs ?? []), '--config', overlay],
        ...(sessionFile ? { sessionFile, lineage } : {})
      },
      env,
      inheritedEnvToDelete: PI_RPC_SESSION_ENV_TO_DELETE
    }
  }
}
