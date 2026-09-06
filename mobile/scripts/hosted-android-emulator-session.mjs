import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { pairingPublicKeyFromUrl } from './emulator-pairing-public-key.mjs'
import { hostedMobileMetroArguments } from './hosted-mobile-e2e-launch.mjs'
import { runAndroidAdb } from './hosted-android-mobile-web-cache.mjs'
import { getMobileExpoExecutablePath } from './mobile-expo-cli.mjs'

const metroStatusMaxBytes = 64 * 1024
const packageName = 'com.stably.orca.mobile'
const activity = `${packageName}/.MainActivity`

export function resolveHostedAndroidAdb(explicitCommand, environment = process.env) {
  if (explicitCommand) {
    return explicitCommand
  }
  const sdkRoots = [environment.ANDROID_HOME, environment.ANDROID_SDK_ROOT].filter(Boolean)
  const candidates = [
    ...sdkRoots.map((root) => path.join(root, 'platform-tools', adbName())),
    ...(process.platform === 'darwin'
      ? ['/opt/homebrew/share/android-commandlinetools/platform-tools/adb']
      : [])
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? 'adb'
}

export async function buildHostedAndroidDebugApp({ adb, androidDir, environment = process.env }) {
  const architecture = await runAndroidAdb(adb, ['shell', 'getprop', 'ro.product.cpu.abi'])
  if (!/^[a-zA-Z0-9_-]+$/u.test(architecture)) {
    throw new Error(`Android emulator returned an invalid architecture: ${architecture}`)
  }
  const homebrewJavaHome = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home'
  const javaHome =
    existingPath(environment.JAVA_HOME) ??
    (process.platform === 'darwin' && existsSync(homebrewJavaHome) ? homebrewJavaHome : undefined)
  const sdkRoot =
    existingPath(environment.ANDROID_HOME) ??
    existingPath(environment.ANDROID_SDK_ROOT) ??
    (path.isAbsolute(adb) ? path.dirname(path.dirname(adb)) : undefined)
  await runChild(
    path.join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'),
    [':app:assembleDebug', `-PreactNativeArchitectures=${architecture}`],
    {
      cwd: androidDir,
      env: {
        ...environment,
        ...(javaHome ? { JAVA_HOME: javaHome } : {}),
        ...(sdkRoot ? { ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot } : {})
      },
      stdio: 'inherit'
    }
  )
}

export async function startHostedAndroidMetro({ mobileDir, pairingUrl, port }) {
  const selectedPort = port ?? (await findAvailableLoopbackPort())
  const expo = getMobileExpoExecutablePath(mobileDir)
  if (!expo) {
    throw new Error('Mobile Expo CLI is unavailable')
  }
  const output = { value: '' }
  const child = spawn(expo, hostedMobileMetroArguments(selectedPort, true), {
    cwd: mobileDir,
    env: {
      ...process.env,
      EXPO_NO_TELEMETRY: '1',
      EXPO_PUBLIC_ORCA_E2E_MOBILE_WEB_HOST_PUBLIC_KEY: pairingPublicKeyFromUrl(pairingUrl)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  captureOutput(child.stdout, output)
  captureOutput(child.stderr, output)
  try {
    await waitForMetro(child, selectedPort, output)
    return { child, port: selectedPort, stop: () => stopChild(child) }
  } catch (error) {
    await stopChild(child)
    throw error
  }
}

export async function installAndResetHostedAndroidApp(adb, apk, runAdb = runAndroidAdb) {
  await runAdb(adb, ['install', '-r', '-d', '-t', apk], 120_000)
  await runAdb(adb, ['shell', 'pm', 'clear', packageName])
  await runAdb(adb, [
    'shell',
    'pm',
    'grant',
    packageName,
    'android.permission.POST_NOTIFICATIONS'
  ]).catch(() => {})
}

export async function launchHostedAndroidDevClient(adb, metroPort, probe) {
  const metroUrl = `http://127.0.0.1:${metroPort}`
  const devClientUrl = `exp+orca-mobile://expo-development-client/?url=${encodeURIComponent(
    metroUrl
  )}`
  await runAndroidAdb(adb, ['shell', 'am', 'force-stop', packageName])
  await runAndroidAdb(
    adb,
    [
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      activity,
      '-a',
      'android.intent.action.VIEW',
      '-d',
      devClientUrl,
      '--es',
      'ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_PORT',
      String(probe.port),
      '--es',
      'ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_TOKEN',
      probe.token
    ],
    60_000
  )
}

export async function waitForHostedAndroidReactReady(adb, timeoutMs, runAdb = runAndroidAdb) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'Android app process is unavailable'
  while (Date.now() < deadline) {
    try {
      const pid = await runAdb(adb, ['shell', 'pidof', packageName])
      if (!/^\d+$/u.test(pid)) {
        throw new Error('Android app process is unavailable')
      }
      const logcat = await runAdb(adb, ['logcat', '--pid', pid, '-d', '-v', 'brief'])
      if (/Running "main"/u.test(logcat)) {
        return pid
      }
      lastError = 'React main has not mounted'
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(250)
  }
  throw new Error(`Android React runtime was unavailable: ${lastError}`)
}

export function openHostedAndroidUrl(adb, url) {
  return runAndroidAdb(
    adb,
    [
      'shell',
      'am',
      'start',
      '-W',
      '-n',
      activity,
      '-a',
      'android.intent.action.VIEW',
      '-c',
      'android.intent.category.BROWSABLE',
      '-d',
      url
    ],
    60_000
  )
}

export async function forwardHostedAndroidInspector(adb, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'Android app process is unavailable'
  while (Date.now() < deadline) {
    try {
      const pid = await runAndroidAdb(adb, ['shell', 'pidof', packageName])
      if (!/^\d+$/u.test(pid)) {
        throw new Error('Android app process is unavailable')
      }
      const socket = `webview_devtools_remote_${pid}`
      const sockets = await runAndroidAdb(adb, ['shell', 'cat', '/proc/net/unix'])
      if (!sockets.includes(`@${socket}`)) {
        throw new Error('Android WebView inspector socket is unavailable')
      }
      const portValue = await runAndroidAdb(adb, ['forward', 'tcp:0', `localabstract:${socket}`])
      const port = Number.parseInt(portValue, 10)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid Android inspector port: ${portValue}`)
      }
      return { pid, port }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await delay(250)
    }
  }
  throw new Error(`Android WebView inspector was unavailable: ${lastError}`)
}

export async function stopHostedAndroidApp(adb) {
  await runAndroidAdb(adb, ['shell', 'am', 'force-stop', packageName]).catch(() => {})
}

export function findHostedAndroidBridgeLogFailures(logcat, appPid) {
  return logcat.split(/\r?\n/u).filter((line) => {
    const fatal = /FATAL EXCEPTION/iu.test(line)
    if (fatal && appPid && !line.includes(`(${appPid})`)) {
      return false
    }
    return /FATAL EXCEPTION|Call to function 'ExpoMobileWebShell\.[^']+' has been rejected|mobile_web_shell_view_unavailable|Cannot convert .* to a Kotlin type|ClassCastException.*MobileWebShellView/iu.test(
      line
    )
  })
}

export async function assertHostedAndroidBridgeLogClean(adb, runAdb = runAndroidAdb) {
  const appPid = await runAdb(adb, ['shell', 'pidof', packageName])
  if (!/^\d+$/u.test(appPid)) {
    throw new Error('Android app process is unavailable')
  }
  const logcat = await runAdb(adb, ['logcat', '--pid', appPid, '-d', '-v', 'brief'])
  const failures = findHostedAndroidBridgeLogFailures(logcat, appPid)
  if (failures.length > 0) {
    throw new Error(`Android bridge emitted errors:\n${failures.slice(0, 16).join('\n')}`)
  }
}

function adbName() {
  return process.platform === 'win32' ? 'adb.exe' : 'adb'
}

function existingPath(value) {
  return value && existsSync(value) ? value : undefined
}

function findAvailableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('No loopback port'))
      )
    })
  })
}

async function waitForMetro(child, port, output) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Metro exited before readiness.\n${output.value}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(2_000)
      })
      const text = (await response.text()).slice(0, metroStatusMaxBytes)
      if (response.ok && text.includes('packager-status:running')) {
        return
      }
    } catch {}
    await delay(250)
  }
  throw new Error(`Metro timed out.\n${output.value}`)
}

function captureOutput(stream, output) {
  stream?.on('data', (chunk) => {
    output.value = (output.value + String(chunk)).slice(-32 * 1024)
  })
}

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${path.basename(command)} was terminated by ${signal}`))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${path.basename(command)} exited with code ${code}`))
      }
    })
  })
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return
  }
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5_000).then(() => child.exitCode === null && child.kill('SIGKILL'))
  ])
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
