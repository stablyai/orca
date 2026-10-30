import { isAbsolute, win32 } from 'node:path'
import { resolveStartupShell, tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import {
  resolveCliCommand,
  resolveExecutableCommand
} from '../../shared/node-cli-command-resolution'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import {
  probeZcodeOfficialRuntimes,
  resolveZcodeOfficialRuntime,
  type ZcodeOfficialRuntimeDeps
} from './zcode-official-runtime'

export type ZcodeCliInvocation = {
  command: string
  prefixArgs: string[]
  envOverlay: Record<string, string>
  identity: string
  source: 'standalone' | 'desktop-bundle'
}

export function zcodeDesktopTerminalRefusal(invocation: ZcodeCliInvocation): string | null {
  return invocation.source === 'desktop-bundle'
    ? 'ZCode Desktop does not include the terminal TUI. Use ZCode Chat or install the standalone ZCode CLI.'
    : null
}

export type ResolveZcodeCliInvocationOptions = {
  commandSettings?: StructuredAgentCommandSettings
  resolveCommand?: typeof resolveCliCommand
  pathEnv?: string
  homePath?: string
  platform?: NodeJS.Platform
  officialRuntime?: ZcodeOfficialRuntimeDeps
}

function invocationIdentity(invocation: Omit<ZcodeCliInvocation, 'identity'>): string {
  return JSON.stringify([
    invocation.source,
    invocation.command,
    invocation.prefixArgs,
    Object.entries(invocation.envOverlay).sort(([left], [right]) => left.localeCompare(right))
  ])
}

function withIdentity(invocation: Omit<ZcodeCliInvocation, 'identity'>): ZcodeCliInvocation {
  return { ...invocation, identity: invocationIdentity(invocation) }
}

function isAbsoluteForPlatform(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path)
}

function parseOverride(
  raw: string,
  options: ResolveZcodeCliInvocationOptions
): { command: string; prefixArgs: string[] } | null {
  const input = raw.trim()
  if (!input || /[\0\r\n]/.test(input)) {
    return null
  }
  const parsed = tokenizeStartupCommand(
    input,
    resolveStartupShell(options.platform ?? process.platform)
  )
  if (
    !parsed.ok ||
    parsed.tokens.length === 0 ||
    parsed.spans.some((span) => span.divergesFromShell)
  ) {
    return null
  }
  const [program, ...prefixArgs] = parsed.tokens
  if (!program) {
    return null
  }
  const command = options.resolveCommand
    ? options.resolveCommand(program, {
        pathEnv: options.pathEnv,
        homePath: options.homePath,
        platform: options.platform
      })
    : resolveExecutableCommand(program, {
        pathEnv: options.pathEnv,
        homePath: options.homePath,
        platform: options.platform
      })
  return command && isAbsoluteForPlatform(command, options.platform ?? process.platform)
    ? { command, prefixArgs }
    : null
}

function desktopInvocation(
  electron: string,
  bundle: string,
  builtinProviderConfig?: string
): ZcodeCliInvocation {
  return withIdentity({
    command: electron,
    prefixArgs: [bundle],
    envOverlay: {
      ELECTRON_RUN_AS_NODE: '1',
      ...(builtinProviderConfig
        ? {
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinProviderConfig,
            ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: builtinProviderConfig
          }
        : {})
    },
    source: 'desktop-bundle'
  })
}

/** Resolve the executable and prefix args for a ZCode CLI or Desktop bundle. */
export function resolveZcodeCliInvocation(
  options: ResolveZcodeCliInvocationOptions = {}
): ZcodeCliInvocation {
  const override = options.commandSettings?.agentCmdOverrides?.zcode?.trim()
  if (override) {
    const parsed = parseOverride(override, options)
    if (!parsed) {
      throw new Error('the zcode Command setting is not a runnable command')
    }
    const official =
      parsed.prefixArgs.length === 0
        ? resolveZcodeOfficialRuntime(parsed.command, options.officialRuntime ?? {})
        : null
    return official
      ? desktopInvocation(official.electron, official.bundle, official.builtinProviderConfig)
      : withIdentity({
          command: parsed.command,
          prefixArgs: parsed.prefixArgs,
          envOverlay: {},
          source: 'standalone'
        })
  }

  const command = (options.resolveCommand ?? resolveCliCommand)('zcode', {
    pathEnv: options.pathEnv,
    homePath: options.homePath,
    platform: options.platform
  })
  const official = resolveZcodeOfficialRuntime(command, options.officialRuntime ?? {})
  if (official) {
    return desktopInvocation(official.electron, official.bundle, official.builtinProviderConfig)
  }
  if (isAbsoluteForPlatform(command, options.platform ?? process.platform)) {
    return withIdentity({
      command,
      prefixArgs: [],
      envOverlay: {},
      source: 'standalone'
    })
  }

  const conventional = probeZcodeOfficialRuntimes([], {
    home: options.homePath,
    platform: options.platform,
    ...options.officialRuntime
  })
  return conventional
    ? desktopInvocation(
        conventional.electron,
        conventional.bundle,
        conventional.builtinProviderConfig
      )
    : withIdentity({
        command,
        prefixArgs: [],
        envOverlay: {},
        source: 'standalone'
      })
}
