import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join, win32 as pathWin32 } from 'node:path'
import { resolveWindowsCodexTarget } from './windows-codex-package-resolution'
import { parseGeneratedPowerShellCodexCommand } from './windows-codex-generated-command'
import { resolveWindowsShellLaunchArgs, type WindowsShellWslContext } from './windows-shell-args'
import {
  encodeWindowsCodexShellHandoffConfig,
  WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT,
  type WindowsCodexShellChildAttempt,
  type WindowsCodexShellHandoffConfig
} from './windows-codex-shell-handoff-host'

export {
  decodeWindowsCodexShellHandoffConfig,
  encodeWindowsCodexShellHandoffConfig,
  WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT,
  type WindowsCodexShellHandoffConfig
} from './windows-codex-shell-handoff-host'

const WINDOWS_CREATE_PROCESS_COMMAND_LINE_MAX_CHARS = 32_767
const WINDOWS_CODEX_HANDOFF_COMMAND_LINE_MARGIN_CHARS = 4_000

function getWindowsCommandLineChars(file: string, args: string[]): number {
  return [file, ...args].reduce((total, arg, index) => {
    const hasLopsidedEnclosingQuote = (arg[0] !== '"') !== (arg.at(-1) !== '"')
    const hasNoEnclosingQuotes = arg[0] !== '"' && arg.at(-1) !== '"'
    const quote =
      arg === '' ||
      ((arg.includes(' ') || arg.includes('\t')) &&
        arg.length > 1 &&
        (hasLopsidedEnclosingQuote || hasNoEnclosingQuotes))
    let escapedChars = 0
    let backslashes = 0
    for (const char of arg) {
      if (char === '\\') {
        backslashes += 1
      } else if (char === '"') {
        escapedChars += backslashes * 2 + 2
        backslashes = 0
      } else {
        escapedChars += backslashes + 1
        backslashes = 0
      }
    }
    escapedChars += quote ? backslashes * 2 + 2 : backslashes
    return total + (index === 0 ? 0 : 1) + escapedChars
  }, 0)
}

export type WindowsCodexShellHandoffAttempt = {
  shellPath: string
  shellArgs: string[]
  logicalShellPath: string
  effectiveCwd: string
  validationCwd: string
  startupCommandDeliveredInShellArgs: true
}

type WindowsCodexShellSourceAttempt = {
  shellPath: string
  shellArgs: string[]
  effectiveCwd: string
  validationCwd: string
  startupCommandDeliveredInShellArgs: boolean
}

type WindowsCodexShellHandoffResolveOptions = {
  platform?: NodeJS.Platform
  arch?: string
  pathEnv?: string | null
}

function resolveNodeHost(args: { pathEnv: string | null | undefined }): string | null {
  for (const rawDirectory of args.pathEnv?.split(delimiter) ?? []) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '')
    if (!directory) {
      continue
    }
    const commandPath = join(directory, 'node.exe')
    if (isAbsolute(commandPath) && existsSync(commandPath)) {
      return commandPath
    }
  }
  return null
}

function toChildAttempt(attempt: WindowsCodexShellSourceAttempt): WindowsCodexShellChildAttempt {
  return { file: attempt.shellPath, args: attempt.shellArgs, cwd: attempt.effectiveCwd }
}

function isPowerShellFamily(shellPath: string): boolean {
  const basename = pathWin32.basename(shellPath).toLowerCase()
  return basename === 'pwsh.exe' || basename === 'powershell.exe'
}

export function buildWindowsCodexShellHandoffAttempt(args: {
  fallbackAttempts: WindowsCodexShellSourceAttempt[]
  cwd: string
  defaultCwd: string
  wslContext?: WindowsShellWslContext
  startupCommand?: string
  launchAgent?: string
  windowsCodexShellHandoff?: boolean
  env: Record<string, string>
  resolveOptions?: WindowsCodexShellHandoffResolveOptions
}): WindowsCodexShellHandoffAttempt | null {
  try {
    const platform = args.resolveOptions?.platform ?? process.platform
    const primaryAttempt = args.fallbackAttempts[0]
    if (
      platform !== 'win32' ||
      args.launchAgent !== 'codex' ||
      args.windowsCodexShellHandoff !== true ||
      !args.startupCommand ||
      !primaryAttempt
    ) {
      return null
    }
    const agentArgs = parseGeneratedPowerShellCodexCommand(args.startupCommand)
    if (!agentArgs) {
      return null
    }
    const pathEnv =
      args.resolveOptions?.pathEnv ?? args.env.PATH ?? args.env.Path ?? args.env.path ?? null
    const arch = args.resolveOptions?.arch ?? process.arch
    const agent = resolveWindowsCodexTarget({
      env: args.env,
      arch,
      pathEnv,
      pathExt: args.env.PATHEXT ?? args.env.PathExt
    })
    const nodeHost = resolveNodeHost({ pathEnv })
    if (!agent || !nodeHost || !existsSync(nodeHost)) {
      return null
    }
    const agentCommandLineChars = getWindowsCommandLineChars(agent.file, agentArgs)
    if (
      agentCommandLineChars >
      WINDOWS_CREATE_PROCESS_COMMAND_LINE_MAX_CHARS -
        WINDOWS_CODEX_HANDOFF_COMMAND_LINE_MARGIN_CHARS
    ) {
      return null
    }

    const shellAttempts = args.fallbackAttempts.map((attempt) => {
      const launch = resolveWindowsShellLaunchArgs(
        attempt.shellPath,
        args.cwd,
        args.defaultCwd,
        args.wslContext
      )
      return { file: attempt.shellPath, args: launch.shellArgs, cwd: launch.effectiveCwd }
    })
    const agentFallbackAttempts = args.fallbackAttempts
      // Why: the generated launch text is PowerShell syntax. Passing it to cmd
      // can reinterpret quoting and prompt metacharacters after a native spawn race.
      .filter(
        (attempt) =>
          attempt.startupCommandDeliveredInShellArgs && isPowerShellFamily(attempt.shellPath)
      )
      .map(toChildAttempt)
    if (agentFallbackAttempts.length === 0) {
      return null
    }
    const config: WindowsCodexShellHandoffConfig = {
      agentFile: agent.file,
      agentArgs,
      agentEnvToDelete: agent.envToDelete,
      agentEnv: agent.env,
      shellAttempts,
      // Why: a native spawn race may fall back only to shells that already
      // carry the agent command; a plain shell would silently lose the launch.
      agentFallbackAttempts
    }
    const encodedConfig = encodeWindowsCodexShellHandoffConfig(config)
    const estimatedCommandLineChars = getWindowsCommandLineChars(nodeHost, [
      '-e',
      WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT,
      encodedConfig
    ])
    if (
      estimatedCommandLineChars >
      WINDOWS_CREATE_PROCESS_COMMAND_LINE_MAX_CHARS -
        WINDOWS_CODEX_HANDOFF_COMMAND_LINE_MARGIN_CHARS
    ) {
      return null
    }

    return {
      shellPath: nodeHost,
      shellArgs: ['-e', WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT, encodedConfig],
      logicalShellPath: primaryAttempt.shellPath,
      effectiveCwd: primaryAttempt.effectiveCwd,
      validationCwd: primaryAttempt.validationCwd,
      startupCommandDeliveredInShellArgs: true
    }
  } catch {
    // Resolver/filesystem races must preserve the established PowerShell launch path.
    return null
  }
}
