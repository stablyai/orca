import { deflateRawSync, inflateRawSync } from 'node:zlib'

export type WindowsCodexShellChildAttempt = {
  file: string
  args: string[]
  cwd: string
}

export type WindowsCodexShellHandoffConfig = {
  agentFile: string
  agentArgs: string[]
  agentEnvToDelete: string[]
  agentEnv: Record<string, string>
  shellAttempts: WindowsCodexShellChildAttempt[]
  agentFallbackAttempts: WindowsCodexShellChildAttempt[]
}

// Why: this process owns the ConPTY while Codex runs, then starts the selected
// PowerShell only after Codex exits so the pane still returns to its normal shell.
export const WINDOWS_CODEX_SHELL_HANDOFF_HOST_SCRIPT = String.raw`
const { spawn } = require('node:child_process')
const { inflateRawSync } = require('node:zlib')
const config = JSON.parse(inflateRawSync(Buffer.from(process.argv[1], 'base64url')).toString('utf8'))
let activeChild = null
let phase = 'agent'
let shuttingDown = false

const run = (attempt, env) => new Promise((resolve) => {
  let settled = false
  let spawned = false
  const child = spawn(attempt.file, attempt.args, {
    cwd: attempt.cwd,
    env,
    stdio: 'inherit',
    windowsHide: true
  })
  activeChild = child
  const finish = (code) => {
    if (settled) return
    settled = true
    if (activeChild === child) activeChild = null
    resolve({ spawned, code: typeof code === 'number' ? code : 1 })
  }
  child.once('spawn', () => { spawned = true })
  child.once('error', (error) => {
    process.stderr.write('[orca] Failed to launch ' + attempt.file + ': ' + error.message + '\n')
    finish(1)
  })
  child.once('exit', (code) => finish(code))
})

const runFirstAvailable = async (attempts, env) => {
  for (const attempt of attempts) {
    // Why: teardown must never create a replacement child after the active
    // attempt exits or fails in response to SIGTERM/SIGHUP.
    if (shuttingDown) return 1
    const result = await run(attempt, env)
    if (result.spawned || shuttingDown) return result.code
  }
  return 1
}

const forwardSignal = (signal, terminateHost) => {
  if (terminateHost) shuttingDown = true
  if (!activeChild || activeChild.killed) return
  try { activeChild.kill(signal) } catch {}
}

// Normal Ctrl+C is PTY input delivered by ConPTY. Only forward an explicit
// process-level SIGINT while Codex owns the pane; killing the later shell would
// close a terminal whose agent already exited.
process.on('SIGINT', () => {
  if (phase === 'agent') forwardSignal('SIGINT', false)
})
process.on('SIGTERM', () => forwardSignal('SIGTERM', true))
process.on('SIGHUP', () => forwardSignal('SIGHUP', true))

;(async () => {
  const agentEnv = { ...process.env }
  for (const key of config.agentEnvToDelete) delete agentEnv[key]
  Object.assign(agentEnv, config.agentEnv)
  const agentResult = await run(
    { file: config.agentFile, args: config.agentArgs, cwd: process.cwd() },
    agentEnv
  )
  if (shuttingDown) return
  phase = 'shell'
  process.exitCode = agentResult.spawned
    ? await runFirstAvailable(config.shellAttempts, process.env)
    : await runFirstAvailable(config.agentFallbackAttempts, process.env)
})().catch((error) => {
  process.stderr.write('[orca] Windows Codex handoff failed: ' + error.message + '\n')
  process.exitCode = 1
})
`

export function encodeWindowsCodexShellHandoffConfig(
  config: WindowsCodexShellHandoffConfig
): string {
  return deflateRawSync(Buffer.from(JSON.stringify(config), 'utf8')).toString('base64url')
}

export function decodeWindowsCodexShellHandoffConfig(attempt: {
  shellArgs: string[]
}): WindowsCodexShellHandoffConfig {
  const encoded = attempt.shellArgs[2]
  if (!encoded) {
    throw new Error('Windows Codex shell handoff is missing its encoded configuration.')
  }
  return JSON.parse(
    inflateRawSync(Buffer.from(encoded, 'base64url')).toString('utf8')
  ) as WindowsCodexShellHandoffConfig
}
