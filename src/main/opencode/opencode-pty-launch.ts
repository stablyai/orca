import { addWslEnvKeys } from '../../shared/wsl-env'
import type { TuiAgent } from '../../shared/tui-agent'
import { randomUUID, createHash } from 'node:crypto'
import { agentHookServer } from '../agent-hooks/server'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { isOpenCodeRunCommand } from '../../shared/opencode-headless-command'
import {
  OPENCODE_STARTUP_PROMPT_SHA256_ENV,
  OPENCODE_STARTUP_PROMPT_NONCE_ENV,
  OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV,
  OPENCODE_STARTUP_PROMPT_BODY_ENV,
  OPENCODE_STARTUP_PROMPT_SHELL_ENV
} from '../../shared/opencode-startup-prompt'

const intentKeys = [
  OPENCODE_STARTUP_PROMPT_SHA256_ENV,
  OPENCODE_STARTUP_PROMPT_NONCE_ENV,
  OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV,
  OPENCODE_STARTUP_PROMPT_BODY_ENV,
  OPENCODE_STARTUP_PROMPT_SHELL_ENV
]

import { deleteRequestedEnvKeys } from '../ipc/pty/host-env/path'
import { probeOpenCodeLaunchCapabilities } from './opencode-launch-capabilities'
import { reserveOpenCodeStartupPrompt } from './opencode-startup-prompt-owner'
import { installOpenCodeStartupPromptForLaunch } from './opencode-startup-prompt-installer'

export async function prepareOpenCodePtyLaunch(options: {
  command: string | undefined
  agent?: TuiAgent
  env: Record<string, string> | undefined
  envToDelete: string[]
  cwd?: string
  connectionId?: string | null
  isFreshLaunch: boolean
  wsl?: { distro?: string }
}): Promise<{ env: Record<string, string> | undefined; command: string | undefined }> {
  let command = options.command
  const env = options.env ? { ...options.env } : undefined
  const requestedPrompt = env?.[OPENCODE_STARTUP_PROMPT_SHA256_ENV]
  const body = env?.[OPENCODE_STARTUP_PROMPT_BODY_ENV]
  const shell = env?.[OPENCODE_STARTUP_PROMPT_SHELL_ENV]
  if (env) {
    delete env.ORCA_OPENCODE_PLUGIN_API
    for (const key of intentKeys) {
      delete env[key]
    }
  }
  // Providers merge their own ambient environment after this preparation.
  if (!options.envToDelete.includes('ORCA_OPENCODE_PLUGIN_API')) {
    options.envToDelete.push('ORCA_OPENCODE_PLUGIN_API')
  }
  for (const key of intentKeys) {
    if (!options.envToDelete.includes(key)) {
      options.envToDelete.push(key)
    }
  }
  if (options.connectionId || !options.isFreshLaunch) {
    return { env, command }
  }
  const probeEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) {
      probeEnv[key] = value
    }
  }
  deleteRequestedEnvKeys(probeEnv, options.envToDelete)
  const capabilities = await probeOpenCodeLaunchCapabilities({
    ...options,
    env: probeEnv
  })
  if (!capabilities || capabilities.pluginApi === 'unknown') {
    return { env, command }
  }
  const launchEnv: Record<string, string> = {
    ...env,
    ORCA_OPENCODE_PLUGIN_API: capabilities.pluginApi
  }
  options.envToDelete.splice(options.envToDelete.indexOf('ORCA_OPENCODE_PLUGIN_API'), 1)
  if (
    capabilities.promptMode === 'prefill' &&
    !options.wsl &&
    launchEnv.ORCA_AGENT_LAUNCH_TOKEN &&
    requestedPrompt &&
    body &&
    command &&
    (shell === 'posix' || shell === 'powershell' || shell === 'cmd') &&
    createHash('sha256').update(body).digest('hex') === requestedPrompt
  ) {
    const parsed = tokenizeStartupCommand(command, shell)
    const last = parsed.ok ? parsed.tokens.length - 1 : -1
    if (
      parsed.ok &&
      !isOpenCodeRunCommand(parsed.tokens, shell) &&
      parsed.tokens.filter((token) => token === '--prompt').length === 1 &&
      parsed.tokens[last - 1] === '--prompt' &&
      parsed.tokens[last] === body &&
      !parsed.spans[last].divergesFromShell &&
      !parsed.spans[last - 1].divergesFromShell
    ) {
      const endpoint = agentHookServer.endpointFilePath
      if (endpoint) {
        launchEnv[OPENCODE_STARTUP_PROMPT_SHA256_ENV] = requestedPrompt
        launchEnv[OPENCODE_STARTUP_PROMPT_BODY_ENV] = body
        launchEnv[OPENCODE_STARTUP_PROMPT_NONCE_ENV] = randomUUID()
        launchEnv[OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV] = endpoint
        if (installOpenCodeStartupPromptForLaunch(launchEnv, false, probeEnv)) {
          for (const key of [
            'OPENCODE_CONFIG_DIR',
            'ORCA_OPENCODE_CONFIG_DIR',
            'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
          ]) {
            const deletion = options.envToDelete.indexOf(key)
            if (launchEnv[key] && deletion !== -1) {
              options.envToDelete.splice(deletion, 1)
            }
          }
        }
        const nonce = launchEnv[OPENCODE_STARTUP_PROMPT_NONCE_ENV]
        if (nonce && reserveOpenCodeStartupPrompt(nonce, requestedPrompt)) {
          command = command.slice(0, parsed.spans[last - 1].start).trimEnd()
        } else {
          for (const key of intentKeys) {
            delete launchEnv[key]
          }
        }
        for (const key of intentKeys) {
          if (launchEnv[key]) {
            options.envToDelete.splice(options.envToDelete.indexOf(key), 1)
          }
        }
      }
    }
  }
  if (options.wsl) {
    addWslEnvKeys(launchEnv, ['ORCA_OPENCODE_PLUGIN_API'])
  }
  return { env: launchEnv, command }
}
