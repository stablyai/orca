#!/usr/bin/env node
/**
 * Start Orca Mobile server and load it in the iOS emulator.
 * Looks for emulators in the given worktree.
 *
 * Usage:
 *   node scripts/start-emulator.mjs [--worktree <path>] [--device <name>]
 *
 * Options:
 *   --worktree <path>  Worktree path (default: auto-detect)
 *   --device <name>    Device name (default: 'iPhone 17 Pro')
 *   --port <port>      Metro port (default: first available from 8081)
 *   --no-open          Don't open the app URL automatically
 *   --no-pair          Don't create a temporary paired desktop runtime
 *   --wait-for-ready   Wait for Metro to be ready before opening URL
 *   --screenshot       Take a screenshot after opening
 */

import { spawn, execFile } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import { promisify } from 'node:util'
import path from 'node:path'
import process from 'node:process'
import {
  registerWorktreeForPairingRuntime,
  startHeadlessPairingRuntime
} from './start-emulator-pairing-runtime.mjs'
import {
  appendProcessOutputTail,
  attachBoundedProcessLineReader
} from './bounded-process-line-reader.mjs'
import { responseBodyIncludesWithinLimit } from './bounded-response-body.mjs'
import { ensureMobileExpoCli, getMobileExpoExecutablePath } from './mobile-expo-cli.mjs'

const execFileAsync = promisify(execFile)
const DEFAULT_METRO_PORT = 8081
const METRO_PORT_SEARCH_LIMIT = 100
const METRO_STATUS_MAX_BYTES = 64 * 1024

// Parse CLI arguments
const args = process.argv.slice(2)
const options = {
  worktree: null,
  device: 'iPhone 17 Pro',
  port: null,
  open: true,
  pair: true,
  waitForReady: false,
  screenshot: false
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--worktree' && i + 1 < args.length) {
    options.worktree = args[++i]
  } else if (arg === '--device' && i + 1 < args.length) {
    options.device = args[++i]
  } else if (arg === '--port' && i + 1 < args.length) {
    options.port = args[++i]
  } else if (arg === '--no-open') {
    options.open = false
  } else if (arg === '--no-pair') {
    options.pair = false
  } else if (arg === '--wait-for-ready') {
    options.waitForReady = true
  } else if (arg === '--screenshot') {
    options.screenshot = true
  } else if (arg === '--help' || arg === '-h') {
    console.log(`Usage: node scripts/start-emulator.mjs [options]

Options:
  --worktree <path>  Worktree path (default: auto-detect)
  --device <name>    Device name (default: 'iPhone 17 Pro')
  --port <port>      Metro port (default: first available from 8081)
  --no-open          Don't open the app URL automatically
  --no-pair          Don't create a temporary paired desktop runtime
  --wait-for-ready   Wait for Metro to be ready before opening URL
  --screenshot       Take a screenshot after opening
  --help, -h         Show this help message
`)
    process.exit(0)
  }
}

const ORCA_CLI = process.env.ORCA_CLI || 'orca'

// Colors for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
}

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`)
}

function logStep(step, message) {
  log(`[${step}] ${message}`, 'cyan')
}

function logError(message) {
  log(`[error] ${message}`, 'red')
}

function logSuccess(message) {
  log(`[ok] ${message}`, 'green')
}

function logInfo(message) {
  log(`[info] ${message}`, 'yellow')
}

function createBackpressuredLineWriter(source, target, color) {
  let waitingForDrain = false
  return (line) => {
    const accepted = target.write(color + line + colors.reset + '\n')
    if (accepted || waitingForDrain) {
      return
    }
    waitingForDrain = true
    source.pause()
    target.once('drain', () => {
      waitingForDrain = false
      source.resume()
    })
  }
}

function assertIosSimulatorPlatform() {
  if (process.platform !== 'darwin') {
    throw new Error('iOS Simulator automation requires macOS and Xcode.')
  }
}

// Execute orca CLI command
async function orca(args, options = {}) {
  const { stdout, stderr } = await execFileAsync(ORCA_CLI, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 30000
  })
  return { stdout: stdout.trim(), stderr: stderr.trim() }
}

// Get worktree path - either from CLI or auto-detect
async function getWorktree() {
  if (options.worktree) {
    return path.resolve(options.worktree)
  }

  try {
    const { stdout } = await orca(['worktree', 'current', '--json'])
    const result = JSON.parse(stdout)
    // Handle both response formats
    const worktreePath = result.worktree?.path || result.result?.worktree?.path
    if (worktreePath) {
      return worktreePath
    }
  } catch {
    // Fall through to current directory
  }

  return process.cwd()
}

// Get mobile directory path (worktree/mobile or current directory if already in mobile)
function getMobileDir(worktree) {
  const currentDir = process.cwd()
  if (!options.worktree && path.basename(currentDir) === 'mobile') {
    return currentDir
  }
  return path.join(worktree, 'mobile')
}

async function ensureMobileDependencies(worktree) {
  const mobileDir = getMobileDir(worktree)
  await ensureMobileExpoCli(mobileDir, { logStep, logSuccess })
}

// Attach to emulator
async function attachEmulator(worktree, device, runtime) {
  logStep('1', `Attaching to emulator: ${device.name}`)

  try {
    await orca(['emulator', 'attach', device.udid, '--worktree', worktree, '--focus', '--json'], {
      cwd: worktree,
      env: runtime?.env || process.env,
      timeout: 60000
    })
    logSuccess(`Attached to ${device.name}`)
  } catch (error) {
    logError(`Failed to attach to emulator: ${error.message}`)
    throw error
  }
}

// List available simulators
async function listSimulators() {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'available'], {
      encoding: 'utf8'
    })

    // Parse the output to find iPhone devices
    const lines = stdout.split('\n')
    const devices = []
    let currentRuntime = ''

    for (const line of lines) {
      const runtimeMatch = line.match(/^-- (.+) --$/)
      if (runtimeMatch) {
        currentRuntime = runtimeMatch[1]
      } else {
        const deviceMatch = line.match(/^\s+(.+?) \(([A-F0-9-]+)\)\s*(\(.*\))?\s*$/)
        if (deviceMatch && currentRuntime.includes('iOS')) {
          devices.push({
            name: deviceMatch[1].trim(),
            udid: deviceMatch[2],
            runtime: currentRuntime,
            status: deviceMatch[3] || ''
          })
        }
      }
    }

    return devices
  } catch (error) {
    logError(`Failed to list simulators: ${error.message}`)
    return []
  }
}

// Find the best device to use
async function findBestDevice(requestedDevice) {
  const devices = await listSimulators()

  if (devices.length === 0) {
    throw new Error('No iOS simulators found. Make sure Xcode is installed.')
  }

  // First try exact match
  let device = devices.find((d) => d.name === requestedDevice)

  // Then try partial match
  if (!device) {
    device = devices.find((d) => d.name.toLowerCase().includes(requestedDevice.toLowerCase()))
  }

  // Fall back to first iPhone
  if (!device) {
    device = devices.find((d) => d.name.includes('iPhone'))
  }

  // Last resort: first available
  if (!device) {
    device = devices[0]
  }

  return device
}

function lanIpCandidates() {
  const entries = Object.entries(os.networkInterfaces()).flatMap(([name, interfaces]) =>
    (interfaces || []).map((iface) => ({ name, iface }))
  )
  return entries
    .filter(({ name, iface }) => {
      if (!iface || iface.family !== 'IPv4' || iface.internal) {
        return false
      }
      if (iface.address.startsWith('169.254.')) {
        return false
      }
      return !/^(awdl|bridge|gif|llw|p2p|stf|utun)/.test(name)
    })
    .sort((a, b) => interfaceRank(a.name) - interfaceRank(b.name))
    .map(({ iface }) => iface.address)
}

function interfaceRank(name) {
  if (/^(en|eth|wlan)/.test(name)) {
    return 0
  }
  return 1
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0'
}

function normalizeMetroUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    const lanIp = lanIpCandidates()[0]
    if (lanIp && isLoopbackHost(url.hostname)) {
      url.hostname = lanIp
    }
    return url.toString().replace(/\/$/, '')
  } catch {
    return rawUrl
  }
}

function metroUrlCandidates(initialUrl) {
  try {
    const url = new URL(initialUrl)
    const hosts = [url.hostname, ...lanIpCandidates(), 'localhost', '127.0.0.1']
    const uniqueHosts = [...new Set(hosts.filter(Boolean))]
    return uniqueHosts.map((host) => {
      const candidate = new URL(url.toString())
      candidate.hostname = host
      return candidate.toString().replace(/\/$/, '')
    })
  } catch {
    return [initialUrl]
  }
}

function devClientUrlForMetroUrl(url) {
  return `exp+orca-mobile://expo-development-client/?url=${encodeURIComponent(url)}`
}

function canListenOnPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(false)
        return
      }
      reject(error)
    })
    server.listen({ port, host: '0.0.0.0' }, () => {
      server.close(() => resolve(true))
    })
  })
}

async function findAvailableMetroPort(startPort) {
  const endPort = startPort + METRO_PORT_SEARCH_LIMIT
  for (let port = startPort; port < endPort; port++) {
    if (await canListenOnPort(port)) {
      return port
    }
  }
  throw new Error(`No available Metro port found from ${startPort} to ${endPort - 1}`)
}

async function resolveMetroPort() {
  if (options.port) {
    const requestedPort = Number(options.port)
    if (!Number.isInteger(requestedPort) || requestedPort <= 0 || requestedPort > 65535) {
      throw new Error(`Invalid Metro port: ${options.port}`)
    }
    return requestedPort
  }

  const port = await findAvailableMetroPort(DEFAULT_METRO_PORT)
  if (port !== DEFAULT_METRO_PORT) {
    logInfo(`Port ${DEFAULT_METRO_PORT} is already in use; using ${port} instead`)
  }
  return port
}

// Start Metro bundler
async function startMetro(worktree) {
  logStep('2', 'Starting Metro bundler...')

  const mobileDir = getMobileDir(worktree)
  const metroPort = await resolveMetroPort()

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      EXPO_NO_TELEMETRY: '1'
    }

    // Use local expo CLI directly instead of pnpm start to avoid workspace issues
    const expoPath = getMobileExpoExecutablePath(mobileDir)
    if (!expoPath) {
      reject(new Error('Mobile Expo CLI is missing after dependency setup.'))
      return
    }
    const expoArgs = ['start', '--host', 'lan', '--port', String(metroPort)]
    logInfo(`Using expo at: ${expoPath}`)
    const metro = spawn(expoPath, expoArgs, {
      cwd: mobileDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let output = ''
    let url = null
    let resolved = false
    let exited = false
    let closeStdout = () => {}
    let closeStderr = () => {}
    const writeStdoutLine = createBackpressuredLineWriter(metro.stdout, process.stdout, colors.dim)
    const writeStderrLine = createBackpressuredLineWriter(metro.stderr, process.stderr, colors.red)

    const metroResult = () => ({
      process: metro,
      url,
      output,
      isExited: () => exited,
      closeOutput: () => {
        closeStdout()
        closeStderr()
        metro.stdin?.destroy()
        metro.stdout?.destroy()
        metro.stderr?.destroy()
      }
    })

    // Parse Metro output for the development URL
    closeStdout = attachBoundedProcessLineReader(metro.stdout, (line) => {
      if (!resolved) {
        output = appendProcessOutputTail(output, line)
      }
      writeStdoutLine(line)

      // Look for "Waiting on" message from Metro
      // When Metro says "Waiting on http://localhost:8081", we need to construct the dev-client URL
      const waitingMatch = line.match(/Waiting on (http:\/\/[^:]+):(\d+)/)
      if (waitingMatch && !resolved) {
        const host = waitingMatch[1]
        const port = waitingMatch[2]
        url = normalizeMetroUrl(`${host}:${port}`)
        logInfo(`Found Metro URL: ${url}`)

        if (!options.waitForReady) {
          resolved = true
          resolve(metroResult())
        }
      }

      // Also check for the dev-client URL format directly
      const urlMatch = line.match(/exp\+orca-mobile:\/\/expo-development-client\/\?url=([^\s]+)/)
      if (urlMatch && !resolved) {
        url = normalizeMetroUrl(decodeURIComponent(urlMatch[1]))
        logInfo(`Found Metro URL: ${url}`)

        if (!options.waitForReady) {
          resolved = true
          resolve(metroResult())
        }
      }

      // Also check for "packager-status:running" or ready indicator
      if (
        line.includes('packager-status:running') ||
        line.includes('Metro waiting') ||
        line.includes('Logs for your project will appear below')
      ) {
        if (url && !resolved) {
          resolved = true
          resolve(metroResult())
        }
      }
    })

    // Also check stderr
    closeStderr = attachBoundedProcessLineReader(metro.stderr, (line) => {
      if (!resolved) {
        output = appendProcessOutputTail(output, line)
      }
      writeStderrLine(line)
    })

    metro.on('error', (error) => {
      if (!resolved) {
        resolved = true
        reject(new Error(`Failed to start Metro: ${error.message}`))
      }
    })

    metro.on('exit', (code) => {
      exited = true
      if (!resolved) {
        resolved = true
        if (code !== 0) {
          reject(new Error(`Metro exited with code ${code}`))
        } else {
          resolve(metroResult())
        }
      }
    })

    // Timeout after 2 minutes
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        metro.kill()
        reject(new Error('Timeout waiting for Metro to start'))
      }
    }, 120000)
  })
}

// Open the app in the simulator
async function openInSimulator(url, deviceUdid) {
  logStep('3', 'Opening app in simulator...')

  const fullUrl = devClientUrlForMetroUrl(url)

  try {
    await execFileAsync('xcrun', ['simctl', 'openurl', deviceUdid, fullUrl])
    logSuccess('Opened app in simulator')
  } catch (error) {
    logError(`Failed to open app: ${error.message}`)
    throw error
  }
}

async function openPairingUrlInSimulator(pairingUrl, deviceUdid, runtime, worktree) {
  if (!pairingUrl || !options.open) {
    return
  }

  logStep('4', 'Pairing mobile app to temporary desktop runtime...')
  await execFileAsync('xcrun', ['simctl', 'openurl', deviceUdid, pairingUrl])
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // Why: the first deep link can arrive while the freshly opened Expo app is
  // still mounting, so resend it once the JS router is ready to receive URLs.
  await execFileAsync('xcrun', ['simctl', 'openurl', deviceUdid, pairingUrl])
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // Why: the mobile app intentionally asks for a trust confirmation before
  // saving a host. This lands on the Pair button on current iPhone simulators.
  await orca(['emulator', 'tap', '0.5', '0.56', '--worktree', worktree, '--json'], {
    cwd: worktree,
    env: runtime?.env || process.env,
    timeout: 30000
  })
  logSuccess('Opened pairing link and confirmed Pair')
}

// Take a screenshot
async function takeScreenshot(
  deviceUdid,
  outputPath = path.join(os.tmpdir(), 'orca-mobile-ios.png')
) {
  logStep('4', 'Taking screenshot...')

  try {
    await execFileAsync('xcrun', ['simctl', 'io', deviceUdid, 'screenshot', outputPath])
    logSuccess(`Screenshot saved to: ${outputPath}`)
    return outputPath
  } catch (error) {
    logError(`Failed to take screenshot: ${error.message}`)
    return null
  }
}

// Verify Metro is reachable
async function verifyMetro(url) {
  const urlObj = new URL(url)
  const statusUrl = new URL('/status', `${urlObj.protocol}//${urlObj.host}`).toString()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(statusUrl, { signal: controller.signal })
    return await responseBodyIncludesWithinLimit(
      response,
      'packager-status:running',
      METRO_STATUS_MAX_BYTES
    )
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function findReachableMetroUrl(initialUrl) {
  for (const candidate of metroUrlCandidates(initialUrl)) {
    if (await verifyMetro(candidate)) {
      return { url: candidate, reachable: true }
    }
  }
  return { url: initialUrl, reachable: false }
}

// Main function
async function main() {
  log(colors.bright + 'Starting Orca Mobile in Emulator\n' + colors.reset)
  let pairingRuntime = null

  try {
    assertIosSimulatorPlatform()

    // Get worktree
    const worktree = await getWorktree()
    logInfo(`Using worktree: ${worktree}`)
    await ensureMobileDependencies(worktree)

    pairingRuntime = await startHeadlessPairingRuntime({
      enabled: options.pair,
      orcaCli: ORCA_CLI,
      cwd: process.cwd(),
      lanIpCandidates,
      logStep,
      logSuccess
    })
    await registerWorktreeForPairingRuntime(pairingRuntime, worktree, {
      orca,
      logStep,
      logSuccess
    })

    // Find best device
    const device = await findBestDevice(options.device)
    logInfo(`Using device: ${device.name} (${device.runtime})`)

    // Why: emulator helpers are worktree-scoped in Orca; attach is idempotent
    // for the active worktree, while a global helper list cannot prove that.
    await attachEmulator(worktree, device, pairingRuntime)

    // Start Metro
    const metro = await startMetro(worktree)
    logSuccess('Metro is running')

    // Verify Metro is reachable
    const reachableMetro = await findReachableMetroUrl(metro.url)
    if (reachableMetro.url !== metro.url) {
      logInfo(`Using reachable Metro URL: ${reachableMetro.url}`)
    }
    metro.url = reachableMetro.url

    if (!reachableMetro.reachable) {
      logError('Metro is not reachable from this machine.')
      logInfo('The app may still work if the simulator can access the LAN IP.')
    } else {
      logSuccess('Metro is reachable')
    }

    // Open in simulator
    if (options.open) {
      await openInSimulator(metro.url, device.udid)
      await openPairingUrlInSimulator(
        pairingRuntime?.pairingUrl,
        device.udid,
        pairingRuntime,
        worktree
      )

      // Take screenshot if requested
      if (options.screenshot) {
        // Wait a moment for the app to load
        await new Promise((r) => setTimeout(r, 3000))
        await takeScreenshot(device.udid)
      }
    } else {
      logInfo(`Metro URL: ${metro.url}`)
      logInfo(`Dev-client URL: ${devClientUrlForMetroUrl(metro.url)}`)
      logInfo('Omit --no-open to automatically open in simulator')
    }

    log(colors.bright + '\nSetup complete!' + colors.reset)
    logInfo('Press Ctrl+C to stop Metro and the temporary desktop runtime')

    // Keep running until Metro exits
    await new Promise((resolve) => {
      let stopping = false
      let stopTimeout = null
      const finish = () => {
        if (stopTimeout) {
          clearTimeout(stopTimeout)
        }
        metro.process.off('exit', finish)
        process.off('SIGINT', stopMetro)
        process.off('SIGTERM', stopMetro)
        metro.closeOutput?.()
        pairingRuntime?.stop()
        resolve()
      }
      const stopMetro = () => {
        if (stopping) {
          finish()
          return
        }
        stopping = true
        metro.process.kill('SIGINT')
        stopTimeout = setTimeout(finish, 2000)
        stopTimeout.unref?.()
      }
      metro.process.once('exit', finish)
      if (metro.isExited()) {
        finish()
        return
      }
      process.once('SIGINT', stopMetro)
      process.once('SIGTERM', stopMetro)
    })
    process.exit(0)
  } catch (error) {
    pairingRuntime?.stop()
    logError(error.message)
    process.exit(1)
  }
}

main()
