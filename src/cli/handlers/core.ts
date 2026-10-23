import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { formatCliStatus, formatStatus, printResult } from '../format'
import { RuntimeClientError, serveOrcaApp } from '../runtime-client'
import { stripElectronRunAsNode } from '../runtime/orca-app-executable'
import { resolveCliStatusCaller } from '../runtime/status-caller'
import { getServeSuperviseValidationError } from '../runtime/serve-supervised-service'
import { getOptionalServePort } from '../runtime/serve-port-flag'
import { getServeOptionValidationError } from '../../shared/serve-option-validation'

function envRecord(): Record<string, string> {
  // Why: the `orca` launcher runs Orca's Electron binary as Node, so this CLI
  // process carries ELECTRON_RUN_AS_NODE=1. Strip it before it reaches the
  // spawned `claude` (and any nested Electron it launches), which would
  // otherwise be forced into headless plain-Node mode.
  const env = stripElectronRunAsNode(process.env)
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function withTeammateModeAuto(args: string[]): string[] {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--teammate-mode' || arg.startsWith('--teammate-mode=')) {
      return args
    }
  }
  return ['--teammate-mode', 'auto', ...args]
}

// Why argv tokens, not the joined string: a prompt argument may mention the flag without setting it.
function requestsTeammateModeIterm2(args: string[]): boolean {
  return args.some(
    (arg, index) =>
      arg === '--teammate-mode=iterm2' ||
      (arg === '--teammate-mode' && args[index + 1] === 'iterm2')
  )
}

// Why: Claude finds `it2` through `$SHELL -lc 'command -v it2'`, whose login PATH would skip the
// shim dir; the probe wrapper resolves it first, and the real shell stays for Claude's Bash tool.
function withIt2ProbeShell(env: Record<string, string>): Record<string, string> {
  const probeShell = env.ORCA_AGENT_TEAMS_IT2_PROBE_SHELL
  if (!probeShell) {
    return env
  }
  // A nested launch already carries the wrapper as SHELL; wrapping it again would loop.
  const realShell =
    env.SHELL && env.SHELL !== probeShell
      ? env.SHELL
      : env.ORCA_AGENT_TEAMS_REAL_SHELL || '/bin/zsh'
  const next: Record<string, string> = {
    ...env,
    ORCA_AGENT_TEAMS_REAL_SHELL: realShell,
    SHELL: probeShell
  }
  if (!env.CLAUDE_CODE_SHELL && /bash|zsh/.test(basename(realShell))) {
    next.CLAUDE_CODE_SHELL = realShell
  }
  return next
}

async function runClaudeAgentTeams(env: Record<string, string>, args: string[]): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn('claude', withTeammateModeAuto(args), {
      stdio: 'inherit',
      env
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (typeof code === 'number') {
        resolve(code)
        return
      }
      resolve(signal ? 1 : 0)
    })
  })
}

export const CORE_HANDLERS: Record<string, CommandHandler> = {
  'claude-teams': async ({ client, rawArgs }) => {
    if (process.platform === 'win32') {
      throw new RuntimeClientError(
        'unsupported_platform',
        'Claude Agent Teams native panes are not supported on Windows.'
      )
    }
    const paneKey = process.env.ORCA_PANE_KEY
    if (!paneKey) {
      throw new RuntimeClientError(
        'invalid_environment',
        'orca claude-teams must be run inside an Orca terminal.'
      )
    }
    const claudeArgs = rawArgs ?? []
    const wantsIterm2 = requestsTeammateModeIterm2(claudeArgs)
    const inheritedEnv = envRecord()
    const response = await client.call<{
      launch: { env: Record<string, string>; envToDelete?: string[] }
    }>('agentTeams.prepareLaunch', {
      paneKey,
      env: inheritedEnv,
      prepareAuth: true,
      ...(wantsIterm2 ? { teammateMode: 'iterm2' } : {})
    })
    // Why: an older runtime strips `teammateMode` and returns a tmux-only env; Claude would then
    // fail to find a usable iTerm2 backend with no hint why.
    if (wantsIterm2 && !response.result.launch.env.ORCA_AGENT_TEAMS_IT2_PROBE_SHELL) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca runtime does not support Claude Agent Teams iTerm2 mode. Update Orca and try again, or use --teammate-mode auto.'
      )
    }
    for (const key of response.result.launch.envToDelete ?? []) {
      delete inheritedEnv[key]
    }
    const launchEnv = { ...inheritedEnv, ...response.result.launch.env }
    process.exitCode = await runClaudeAgentTeams(
      wantsIterm2 ? withIt2ProbeShell(launchEnv) : launchEnv,
      claudeArgs
    )
  },
  open: async ({ client, json }) => {
    const result = await client.openOrca()
    printResult(result, json, formatCliStatus)
  },
  serve: async ({ flags, json }) => {
    const projectRootValue = flags.get('project-root')
    const projectRoot = typeof projectRootValue === 'string' ? projectRootValue : null
    const noPairing = flags.get('no-pairing') === true
    const mobilePairing = flags.get('mobile-pairing') === true
    const grantDesktopControl = flags.get('grant-desktop-control') === true
    const recipeJson = flags.get('recipe-json') === true
    const force = flags.get('force') === true
    const supervise = flags.get('supervise') === true
    const superviseError = getServeSuperviseValidationError({ supervise, recipeJson })
    if (superviseError) {
      throw new RuntimeClientError('invalid_argument', superviseError)
    }
    const validationError = getServeOptionValidationError({
      noPairing,
      mobilePairing,
      grantDesktopControl,
      recipeJson,
      projectRoot
    })
    if (validationError) {
      throw new RuntimeClientError('invalid_argument', validationError)
    }
    const port = getOptionalServePort(flags)
    const pairingAddressValue = flags.get('pairing-address')
    const exitCode = await serveOrcaApp({
      json,
      port,
      pairingAddress: typeof pairingAddressValue === 'string' ? pairingAddressValue : null,
      noPairing,
      mobilePairing,
      grantDesktopControl,
      recipeJson,
      projectRoot,
      ...(force ? { force: true } : {}),
      ...(supervise ? { supervise: true } : {})
    })
    process.exitCode = exitCode
  },
  status: async ({ client, json }) => {
    const result = await client.getCliStatus()
    if (!json && !result.result.runtime.reachable) {
      process.exitCode = 1
    }
    const caller = result.result.runtime.reachable
      ? await resolveCliStatusCaller(client)
      : undefined
    printResult(
      caller === undefined ? result : { ...result, result: { ...result.result, caller } },
      json,
      formatStatus
    )
  }
}
