#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const mobileDir = path.resolve(import.meta.dirname, '..')
const defaultApk = path.join(mobileDir, 'android/app/build/outputs/apk/release/app-release.apk')
const packageName = 'com.stably.orca.mobile'
const activity = `${packageName}/.MainActivity`

async function adb(options, args, timeoutMs = 30_000) {
  const result = await execFileAsync(options.adb, ['-s', options.serial, ...args], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: timeoutMs
  })
  return result.stdout.trim()
}

async function readDeviceBuild(options) {
  const [buildType, debuggable, fingerprint] = await Promise.all([
    adb(options, ['shell', 'getprop', 'ro.build.type']),
    adb(options, ['shell', 'getprop', 'ro.debuggable']),
    adb(options, ['shell', 'getprop', 'ro.build.fingerprint'])
  ])
  if (buildType !== 'user' || debuggable !== '0' || !fingerprint.includes(':user/')) {
    throw new Error(
      `Android Release WebView proof requires a user image; received ${buildType}/${debuggable}`
    )
  }
  return { buildType, debuggable, fingerprint }
}

function installedPackageFlags(dumpsys) {
  const match = dumpsys.match(/^\s+flags=\[([^\]]*)\]/m)
  if (!match) {
    throw new Error('Installed Android package flags are unavailable')
  }
  return match[1].split(/\s+/).filter(Boolean)
}

async function waitForProcess(options) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const pid = await adb(options, ['shell', 'pidof', packageName]).catch(() => '')
    if (/^\d+$/.test(pid)) {
      return pid
    }
    await delay(250)
  }
  throw new Error('Timed out waiting for the Android Release process')
}

async function waitForUiMarker(options) {
  const escapedExpected = escapeXml(options.expectedText)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const hierarchy = await adb(
      options,
      ['exec-out', 'uiautomator', 'dump', '/dev/tty'],
      15_000
    ).catch(() => '')
    if (hierarchy.includes(escapedExpected)) {
      return
    }
    await delay(500)
  }
  throw new Error(`Hosted Android Release UI did not render: ${options.expectedText}`)
}

async function assertNoInspectorSocket(options, pid) {
  const socketName = `webview_devtools_remote_${pid}`
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const sockets = await adb(options, ['shell', 'cat', '/proc/net/unix'])
    if (sockets.includes(`@${socketName}`)) {
      throw new Error(`Android Release exposed ${socketName}`)
    }
    await delay(500)
  }
  return socketName
}

async function assertInspectorEndpointUnavailable(options, socketName) {
  const portValue = await adb(options, ['forward', 'tcp:0', `localabstract:${socketName}`])
  const port = Number.parseInt(portValue, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid Android inspector forwarding port: ${portValue}`)
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(2_000)
    }).catch(() => null)
    if (response) {
      throw new Error('Android Release DevTools discovery endpoint is accessible')
    }
  } finally {
    await adb(options, ['forward', '--remove', `tcp:${port}`]).catch(() => {})
  }
}

function fatalReleaseLogCount(logcat) {
  return logcat
    .split('\n')
    .filter((line) =>
      /FATAL EXCEPTION|AndroidRuntime.*FATAL|mobile_web_.*(?:failed|exception)/i.test(line)
    ).length
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const device = await readDeviceBuild(options)
  if (!options.skipInstall) {
    await adb(options, ['install', '-r', options.apk], 180_000)
  }
  const dumpsys = await adb(options, ['shell', 'dumpsys', 'package', packageName])
  const packageFlags = installedPackageFlags(dumpsys)
  if (packageFlags.includes('DEBUGGABLE')) {
    throw new Error('Installed Android Release package is debuggable')
  }

  await adb(options, ['logcat', '-c'])
  await adb(options, ['shell', 'am', 'force-stop', packageName])
  await adb(options, ['shell', 'am', 'start', '-W', '-n', activity], 60_000)
  const pid = await waitForProcess(options)
  await waitForUiMarker(options)
  const socketName = await assertNoInspectorSocket(options, pid)
  await assertInspectorEndpointUnavailable(options, socketName)
  const logcat = await adb(options, ['logcat', '-d', '-v', 'brief'])
  const fatalLogCount = fatalReleaseLogCount(logcat)
  if (fatalLogCount > 0) {
    throw new Error(`Android Release emitted ${fatalLogCount} fatal mobile WebView logs`)
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        apk: {
          path: options.apk,
          sha256: await sha256File(options.apk)
        },
        device,
        packageFlags,
        pid,
        expectedText: options.expectedText,
        inspectorSocket: 'absent',
        inspectorEndpoint: 'inaccessible',
        fatalLogCount
      },
      null,
      2
    )
  )
}

function parseOptions(args) {
  const options = {
    adb: 'adb',
    serial: process.env.ANDROID_SERIAL ?? '',
    apk: defaultApk,
    expectedText: 'mobile-rearch',
    skipInstall: false
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--adb') {
      options.adb = requireValue(args, ++index, arg)
    } else if (arg === '--serial') {
      options.serial = requireValue(args, ++index, arg)
    } else if (arg === '--apk') {
      options.apk = path.resolve(requireValue(args, ++index, arg))
    } else if (arg === '--expected-text') {
      options.expectedText = requireValue(args, ++index, arg)
    } else if (arg === '--skip-install') {
      options.skipInstall = true
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  if (!options.serial) {
    throw new Error('--serial or ANDROID_SERIAL is required')
  }
  return options
}

function requireValue(args, index, option) {
  const value = args[index]
  if (!value) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
