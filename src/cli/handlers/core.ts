import { spawn } from 'node:child_process'
import { closeSync, fstatSync, openSync } from 'node:fs'
import type { CommandHandler } from '../dispatch'
import { formatCliStatus, formatStatus, printResult } from '../format'
import { RuntimeClientError, serveOrcaApp } from '../runtime-client'
import { stripElectronRunAsNode } from '../runtime/launch'
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

/**
 * A stdin Claude can put into raw mode, or null when inheriting fd 0 is right.
 *
 * Why: the `orca` launcher runs Orca's Electron binary as Node, and that
 * process is handed no TTY on fd 0 even though it is attached to the pane's
 * console. `stdio: 'inherit'` passes that dead descriptor straight through, so
 * Claude's TUI cannot enter raw mode — it renders nothing and reads no keys,
 * while stdout (a real TTY) keeps `-p` print mode working. Opening the console
 * input buffer by name gives Claude the handle the pane actually has.
 *
 * Why fstat and not just isTTY: under Electron a console fd 0 is a character
 * device that simply is not wrapped as a TTY, whereas a redirect is a pipe or a
 * file. Reading it wrong would hijack the input of `orca claude-teams < file`.
 */
function openConsoleStdin(): number | null {
  if (process.platform !== 'win32' || process.stdin.isTTY) {
    return null
  }
  try {
    if (!fstatSync(0).isCharacterDevice()) {
      return null
    }
    return openSync('\\\\.\\CONIN$', 'r+')
  } catch {
    return null
  }
}

async function runClaudeAgentTeams(env: Record<string, string>, args: string[]): Promise<number> {
  const consoleStdin = openConsoleStdin()
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('claude', withTeammateModeAuto(args), {
        stdio: [consoleStdin ?? 'inherit', 'inherit', 'inherit'],
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
  } finally {
    if (consoleStdin !== null) {
      closeSync(consoleStdin)
    }
  }
}

function getOptionalServePort(flags: Map<string, string | boolean>): string | null {
  if (!flags.has('port')) {
    return null
  }
  const rawPort = flags.get('port')
  if (typeof rawPort !== 'string' || rawPort.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --port.')
  }
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RuntimeClientError('invalid_argument', `Invalid --port value: ${rawPort}`)
  }
  return rawPort
}

export const CORE_HANDLERS: Record<string, CommandHandler> = {
  'claude-teams': async ({ client, rawArgs }) => {
    const paneKey = process.env.ORCA_PANE_KEY
    if (!paneKey) {
      throw new RuntimeClientError(
        'invalid_environment',
        'orca claude-teams must be run inside an Orca terminal.'
      )
    }
    const response = await client.call<{ launch: { env: Record<string, string> } }>(
      'agentTeams.prepareLaunch',
      {
        paneKey,
        env: envRecord()
      }
    )
    process.exitCode = await runClaudeAgentTeams(
      {
        ...envRecord(),
        ...response.result.launch.env
      },
      rawArgs ?? []
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
    const recipeJson = flags.get('recipe-json') === true
    const validationError = getServeOptionValidationError({
      noPairing,
      mobilePairing,
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
      recipeJson,
      projectRoot
    })
    process.exitCode = exitCode
  },
  status: async ({ client, json }) => {
    const result = await client.getCliStatus()
    if (!json && !result.result.runtime.reachable) {
      process.exitCode = 1
    }
    printResult(result, json, formatStatus)
  }
}
