import { spawn } from 'node:child_process'
import type { CommandHandler } from '../dispatch'
import { formatCliStatus, formatStatus, printResult } from '../format'
import { RuntimeClientError, serveOrcaApp } from '../runtime-client'
import { stripElectronRunAsNode } from '../runtime/launch'

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

function getOptionalServePort(
  flags: Map<string, string | boolean>,
  flag = 'port',
  // Why: `--port 0` means "pick an ephemeral port", which serve reports back.
  // The preview listener is the fixed target of an external reverse-proxy
  // route, so a port it cannot predict is a misconfiguration, not a request.
  minimum = 0
): string | null {
  if (!flags.has(flag)) {
    return null
  }
  const rawPort = flags.get(flag)
  if (typeof rawPort !== 'string' || rawPort.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing value for --${flag}.`)
  }
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < minimum || port > 65535) {
    throw new RuntimeClientError('invalid_argument', `Invalid --${flag} value: ${rawPort}`)
  }
  return rawPort
}

function getOptionalStringFlag(flags: Map<string, string | boolean>, flag: string): string | null {
  if (!flags.has(flag)) {
    return null
  }
  const value = flags.get(flag)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing value for --${flag}.`)
  }
  return value
}

function getServePreviewFlags(flags: Map<string, string | boolean>): {
  previewPort?: string
  previewBind?: string | null
  previewDomain?: string
  previewAuth?: string | null
  previewToken?: string | null
} {
  const previewPort = getOptionalServePort(flags, 'preview-port', 1)
  const previewBind = getOptionalStringFlag(flags, 'preview-bind')
  const previewDomain = getOptionalStringFlag(flags, 'preview-domain')
  const previewAuth = getOptionalStringFlag(flags, 'preview-auth')
  const previewToken = getOptionalStringFlag(flags, 'preview-token')
  const anyPreviewFlag =
    previewPort !== null ||
    previewBind !== null ||
    previewDomain !== null ||
    previewAuth !== null ||
    previewToken !== null
  if (anyPreviewFlag && (previewPort === null || previewDomain === null)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'The preview proxy requires both --preview-port and --preview-domain.'
    )
  }
  if (previewAuth !== null && previewAuth !== 'open' && previewAuth !== 'token') {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid --preview-auth value: ${previewAuth} (use open or token).`
    )
  }
  // Why: omit the keys entirely when the preview proxy is not requested so the
  // spawned argv (and call-shape assertions) stay identical to pre-preview serves.
  if (!anyPreviewFlag) {
    return {}
  }
  return {
    previewPort: previewPort!,
    previewBind,
    previewDomain: previewDomain!,
    previewAuth,
    previewToken
  }
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
    if (flags.get('no-pairing') === true && flags.get('mobile-pairing') === true) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Use either --mobile-pairing or --no-pairing, not both.'
      )
    }
    if (flags.get('recipe-json') === true && flags.get('no-pairing') === true) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Recipe JSON output requires runtime pairing; remove --no-pairing.'
      )
    }
    if (flags.get('recipe-json') === true && flags.get('mobile-pairing') === true) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Recipe JSON output requires runtime pairing; remove --mobile-pairing.'
      )
    }
    const projectRoot =
      typeof flags.get('project-root') === 'string' ? (flags.get('project-root') as string) : null
    if (flags.get('recipe-json') === true && !projectRoot) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Recipe JSON output requires --project-root.'
      )
    }
    const port = getOptionalServePort(flags)
    const exitCode = await serveOrcaApp({
      json,
      port,
      pairingAddress:
        typeof flags.get('pairing-address') === 'string'
          ? (flags.get('pairing-address') as string)
          : null,
      noPairing: flags.get('no-pairing') === true,
      mobilePairing: flags.get('mobile-pairing') === true,
      recipeJson: flags.get('recipe-json') === true,
      projectRoot,
      ...getServePreviewFlags(flags)
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
