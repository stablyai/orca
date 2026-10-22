import { homedir } from 'node:os'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { probeAgentCliVersion } from '../agent-cli-version-probe'
import {
  resolveAgainAfterRefreshOnMissingProgram,
  resolveStructuredAgentCommand,
  type StructuredAgentCommandSettings
} from '../native-chat/structured-agent-command-resolution'
import type { StructuredAgentLaunchPartResolver } from '../runtime/structured-agent-launch-composition'

export type MuseStructuredLaunch = {
  command: string
  args: string[]
  /** MSP session id a previous handle names, for `session/resume`. */
  resumeSessionId?: string | null
}

// MSP v1 `serve` ships every 1.4 release.
const STRUCTURED_RELEASE_LINES = [{ major: 1, minor: 4 }] as const

export function supportsMuseStructuredVersion(version: string): boolean {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) {
    return false
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  return STRUCTURED_RELEASE_LINES.some(
    (line) => major > line.major || (major === line.major && minor >= line.minor)
  )
}

/** The binary a Muse child runs under with `env`. */
export function resolveMuseCommand(
  env: Readonly<Record<string, string>>,
  commandSettings: StructuredAgentCommandSettings = {},
  resolve?: typeof resolveCliCommand
): string {
  const homePath = env.HOME ?? env.USERPROFILE
  return resolveStructuredAgentCommand(
    'muse',
    commandSettings,
    { pathEnv: env.PATH ?? env.Path ?? null, ...(homePath ? { homePath } : {}) },
    resolve ? { resolve } : {}
  )
}

export type MuseLaunchPartDeps = {
  resolveCommand?: typeof resolveCliCommand
  probeVersion?: typeof probeAgentCliVersion
}

export function museStructuredVersionSupported(
  launch: { command: string; cwd: string; env: Record<string, string> },
  probe: typeof probeAgentCliVersion = probeAgentCliVersion
): Promise<boolean> {
  return probe(
    { program: launch.command, cwd: launch.cwd, env: launch.env },
    supportsMuseStructuredVersion
  )
}

/** The binary and environment a Muse child runs under: the account's home scopes
 *  its auth, sessions, and skills. */
export async function resolveMuseServeInvocation(deps: {
  accountHomePath: string
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  commandSettings?: StructuredAgentCommandSettings
  resolveCommand?: typeof resolveCliCommand
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  resolveWorkingDirectory?: () => Promise<string> | string
}): Promise<{ command: string; env: Record<string, string> }> {
  return resolveAgainAfterRefreshOnMissingProgram(
    async () => {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(await deps.resolveEnvironment())) {
        if (value !== undefined) {
          env[key] = value
        }
      }
      env.HOME = deps.accountHomePath
      return { env, command: resolveMuseCommand(env, deps.commandSettings, deps.resolveCommand) }
    },
    deps.refreshEnvironmentAfterMiss,
    { env: ({ env }) => env, cwd: deps.resolveWorkingDirectory }
  )
}

/** Muse's part of a launch: its home, binary, release check, and resume cursor. */
export function museStructuredLaunchPart(
  deps: MuseLaunchPartDeps
): StructuredAgentLaunchPartResolver<MuseStructuredLaunch> {
  return async (basis) => {
    const { record } = basis
    const cwd = await basis.launchDirectory()
    const accountHomePath =
      'path' in record.accountHome && typeof record.accountHome.path === 'string'
        ? record.accountHome.path
        : homedir()
    const { env, command } = await resolveMuseServeInvocation({
      accountHomePath,
      resolveEnvironment: basis.environment,
      commandSettings: basis.commandSettings(),
      resolveCommand: deps.resolveCommand,
      refreshEnvironmentAfterMiss: basis.refreshAfterMissingProgram,
      resolveWorkingDirectory: () => cwd
    })
    const previous = agentSessionProviderHandleChainHead(record.providerHandleChain)
    let resumeSessionId: string | null = null
    if (previous) {
      if (previous.handle.transport !== 'msp' || previous.handle.agent !== 'muse') {
        throw new Error('Muse resume handle is not an MSP session')
      }
      resumeSessionId = previous.handle.nativeId
    }
    return {
      launch: { command, args: ['serve'], ...(resumeSessionId ? { resumeSessionId } : {}) },
      env,
      inheritedEnvToDelete: []
    }
  }
}
