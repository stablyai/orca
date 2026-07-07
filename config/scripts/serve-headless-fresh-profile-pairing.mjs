#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

const scriptDir = import.meta.dirname
const repoRoot = path.resolve(scriptDir, '..', '..')
const orcaDevScript = path.join(scriptDir, 'orca-dev.mjs')
const fixedProfileDir = process.env.ORCA_HEADLESS_PAIRING_PROFILE_DIR
const parsed = parseArgs(process.argv.slice(2))

if (parsed.help) {
  printHelp()
  process.exit(0)
}

if (parsed.serveArgs.includes('--no-pairing')) {
  console.error('serve-headless-fresh-profile-pairing: --no-pairing cannot print a pairing code.')
  process.exit(2)
}
if (parsed.serveArgs.includes('--recipe-json')) {
  console.error(
    'serve-headless-fresh-profile-pairing: --recipe-json detaches the server and cannot use an ephemeral profile safely.'
  )
  process.exit(2)
}

ensureElectronRuntime()

const profileDir =
  fixedProfileDir ?? mkdtempSync(path.join(tmpdir(), 'orca-headless-pairing-profile-'))
const ownsProfileDir = !fixedProfileDir
mkdirSync(profileDir, { recursive: true })

let cleanedUp = false
let child = null
let sawPairingUrl = false
// Why: temp dev worktrees do not have a root-owned chrome-sandbox; this script
// is only for local headless testing, not packaged production.
const childEnv = {
  ...process.env,
  ORCA_DEV_USER_DATA_PATH: profileDir,
  ...(process.platform === 'linux'
    ? { ELECTRON_DISABLE_SANDBOX: process.env.ELECTRON_DISABLE_SANDBOX ?? '1' }
    : {})
}

console.error(`[headless-pairing] userData=${profileDir}`)
console.error(
  `[headless-pairing] starting: orca-dev serve --json${formatForwardedArgs(parsed.serveArgs)}`
)

child = spawn(process.execPath, [orcaDevScript, 'serve', '--json', ...parsed.serveArgs], {
  cwd: repoRoot,
  detached: process.platform !== 'win32',
  env: childEnv,
  stdio: ['inherit', 'pipe', 'inherit']
})

const stdoutLines = createInterface({ input: child.stdout })
stdoutLines.on('line', (line) => {
  if (!printReadyLine(line)) {
    console.log(line)
  }
})

child.once('error', (error) => {
  console.error(`[headless-pairing] failed to start server: ${error.message}`)
  cleanupProfile()
  process.exitCode = 1
})

child.once('exit', (code, signal) => {
  stdoutLines.close()
  if (!sawPairingUrl && code !== 0) {
    console.error('[headless-pairing] server exited before printing a pairing URL.')
  }
  cleanupProfile()
  if (typeof code === 'number') {
    process.exitCode = code
    return
  }
  process.exitCode = signal ? 1 : 0
})

process.once('SIGINT', () => stopChild('SIGINT'))
process.once('SIGTERM', () => stopChild('SIGTERM'))

/**
 * Parses wrapper flags and forwards everything else to `orca serve`.
 */
function parseArgs(args) {
  const serveArgs = []
  let keepProfile = false
  let help = false
  for (const arg of args) {
    if (arg === '--keep') {
      keepProfile = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    serveArgs.push(arg)
  }
  return { help, keepProfile, serveArgs }
}

/**
 * Prints script usage without touching the dev profile or starting the server.
 */
function printHelp() {
  console.log(`Usage: node config/scripts/serve-headless-fresh-profile-pairing.mjs [--keep] [orca serve flags]

Starts orca-dev serve --json with a fresh isolated userData profile, ensures Electron's dev runtime is usable, and prints the pairing URL.

Wrapper flags:
  --keep        Keep the fresh profile after the server exits.
  -h, --help    Show this help.

Forwarded examples:
  node config/scripts/serve-headless-fresh-profile-pairing.mjs --port 6768
  node config/scripts/serve-headless-fresh-profile-pairing.mjs --pairing-address 100.64.1.20
  node config/scripts/serve-headless-fresh-profile-pairing.mjs --mobile-pairing

Environment:
  ORCA_HEADLESS_PAIRING_PROFILE_DIR=/path/to/profile  Use a fixed profile directory.
`)
}

/**
 * Formats forwarded arguments for the startup log.
 */
function formatForwardedArgs(args) {
  if (args.length === 0) {
    return ''
  }
  return ` ${args.map(formatShellArg).join(' ')}`
}

/**
 * Quotes a shell-ish argument for display only.
 */
function formatShellArg(value) {
  if (/^[\w./:=@+-]+$/.test(value)) {
    return value
  }
  return JSON.stringify(value)
}

/**
 * Runs the same Electron runtime preflight used by dev/start package scripts.
 */
function ensureElectronRuntime() {
  console.error('[headless-pairing] ensuring Electron runtime...')
  const result = spawnSync(
    process.execPath,
    ['config/scripts/ensure-native-runtime.mjs', '--runtime=electron'],
    {
      cwd: repoRoot,
      stdio: 'inherit'
    }
  )
  if (result.error) {
    console.error(`[headless-pairing] Electron runtime preflight failed: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

/**
 * Rewrites the CLI JSON readiness line into the pairing URL testers need.
 */
function printReadyLine(line) {
  let payload
  try {
    payload = JSON.parse(line)
  } catch {
    return false
  }
  if (!payload || payload.type !== 'orca_server_ready') {
    return false
  }
  console.log(`Orca server ready: ${payload.endpoint ?? 'websocket unavailable'}`)
  if (payload.pairing?.webClientUrl) {
    console.log(`Web client URL: ${payload.pairing.webClientUrl}`)
  }
  if (payload.pairing?.url) {
    sawPairingUrl = true
    console.log(`Pairing URL: ${payload.pairing.url}`)
    console.error('[headless-pairing] server is running; press Ctrl+C to stop.')
    return true
  }
  console.log('Pairing URL: unavailable')
  return true
}

/**
 * Stops the foreground server so its normal shutdown path can cleanly persist state.
 */
function stopChild(signal) {
  if (!child || child.killed) {
    return
  }
  if (process.platform !== 'win32' && child.pid) {
    // Why: orca-dev synchronously owns the CLI child, which owns Electron; kill
    // the spawned process group so programmatic shutdown does not orphan serve.
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall back to the direct child below if the process group already exited.
    }
  }
  child.kill(signal)
}

/**
 * Removes only the ephemeral profile directory this script created.
 */
function cleanupProfile() {
  if (cleanedUp) {
    return
  }
  cleanedUp = true
  if (parsed.keepProfile || !ownsProfileDir) {
    console.error(`[headless-pairing] kept ${profileDir}`)
    return
  }
  if (!existsSync(profileDir) || !profileDir.includes('orca-headless-pairing-profile-')) {
    console.error(`[headless-pairing] skipped cleanup for unexpected profile path: ${profileDir}`)
    return
  }
  rmSync(profileDir, { recursive: true, force: true })
  console.error(`[headless-pairing] removed ${profileDir}`)
}
