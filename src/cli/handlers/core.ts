import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import type { CommandHandler } from '../dispatch'
import { formatCliStatus, formatStatus, printResult } from '../format'
import { RuntimeClientError, serveOrcaApp } from '../runtime-client'
import { stripElectronRunAsNode } from '../runtime/launch'
import { getServeOptionValidationError } from '../../shared/serve-option-validation'
import {
  buildServeUpdateHelperInstallScript,
  SERVE_UPDATE_HELPER_INSTALL_PATH,
  SERVE_UPDATE_SUDOERS_PATH
} from '../../main/cli/serve-update-helper-installer'

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
  'serve update-helper install': async ({ flags, json }) => {
    if (process.platform === 'win32') {
      throw new RuntimeClientError(
        'unsupported_platform',
        'The serve auto-update helper is only supported on Linux.'
      )
    }
    const option = (name: string, fallback: string): string => {
      const value = flags.get(name)
      if (typeof value !== 'string' || value.length === 0) {
        return fallback
      }
      return value
    }
    const spoolDir = option('spool-dir', '/var/lib/orca-server-update')
    const unitName = option('unit', 'orca-serve.service')
    const appImageTargetPath = option('appimage', '/opt/orca/orca-linux.AppImage')
    const versionRecordPath = option('version-record', '/opt/orca/VERSION')
    const serviceUser = option('service-user', 'orca')
    const outPath = flags.get('out')
    const script = buildServeUpdateHelperInstallScript({
      spoolDir,
      unitName,
      appImageTargetPath,
      versionRecordPath,
      serviceUser
    })
    if (typeof outPath === 'string' && outPath.length > 0) {
      writeFileSync(outPath, script, { mode: 0o755 })
      const lines = [
        `Install script written to ${outPath}.`,
        `Run it with: sudo bash ${outPath}`,
        `Helper will be installed at ${SERVE_UPDATE_HELPER_INSTALL_PATH}.`
      ]
      if (json) {
        console.log(
          JSON.stringify(
            {
              result: {
                written: outPath,
                helperPath: SERVE_UPDATE_HELPER_INSTALL_PATH,
                sudoersPath: SERVE_UPDATE_SUDOERS_PATH
              }
            },
            null,
            2
          )
        )
      } else {
        for (const line of lines) {
          console.log(line)
        }
      }
      return
    }
    process.stdout.write(script)
  },
  status: async ({ client, json }) => {
    const result = await client.getCliStatus()
    if (!json && !result.result.runtime.reachable) {
      process.exitCode = 1
    }
    printResult(result, json, formatStatus)
  }
}
