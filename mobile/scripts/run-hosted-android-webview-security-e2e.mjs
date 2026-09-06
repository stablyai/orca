#!/usr/bin/env node

import { execFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import {
  verifyHostedWebViewNavigationIsolation,
  verifyHostedWebViewNetworkIsolation,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { verifyHostedWebViewExecutableIsolation } from './hosted-webview-executable-isolation.mjs'
import { verifyHostedWebViewPrivacyIsolation } from './hosted-webview-privacy-isolation.mjs'
import { startHostedWebViewSecurityProbe } from './hosted-ios-webview-security-probe.mjs'

const execFileAsync = promisify(execFile)
const mobileDir = path.resolve(import.meta.dirname, '..')
const defaultApk = path.join(mobileDir, 'android/app/build/outputs/apk/debug/app-debug.apk')
const packageName = 'com.stably.orca.mobile'
const activity = `${packageName}/.MainActivity`
const probePortKey = 'ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_PORT'
const probeTokenKey = 'ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_TOKEN'
const metroPort = 8081

async function adb(args, options = {}) {
  const result = await execFileAsync(options.command ?? 'adb', args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: options.timeoutMs ?? 30_000
  })
  return result.stdout.trim()
}

async function waitForProcess(command) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const pid = await adb(['shell', 'pidof', packageName], { command }).catch(() => '')
    if (/^\d+$/.test(pid)) {
      return pid
    }
    await delay(250)
  }
  throw new Error('Timed out waiting for the Android app process')
}

async function waitForWebViewSocket(command, pid) {
  const expected = `webview_devtools_remote_${pid}`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const sockets = await adb(['shell', 'cat', '/proc/net/unix'], { command })
    if (sockets.includes(`@${expected}`)) {
      return expected
    }
    await delay(250)
  }
  throw new Error('Timed out waiting for the Android WebView inspector socket')
}

async function forwardInspector(command, socketName) {
  const value = await adb(['forward', 'tcp:0', `localabstract:${socketName}`], {
    command
  })
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid Android inspector forwarding port: ${value}`)
  }
  return port
}

async function proveSentinelReachability(command, port, probe) {
  await adb(['shell', 'nc', '-z', '-w', '5', '127.0.0.1', String(port)], { command })
  if (!probe.observations.includes('tcp:connection')) {
    throw new Error(
      `Android loopback sentinel red check did not arrive: ${probe.observations.join(', ')}`
    )
  }
  probe.reset()
}

async function launchExactApp(command, probe, devClientUrl) {
  await adb(['shell', 'am', 'force-stop', packageName], { command })
  await adb(
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
      probePortKey,
      String(probe.port),
      '--es',
      probeTokenKey,
      probe.token
    ],
    { command, timeoutMs: 60_000 }
  )
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const probe = await startHostedWebViewSecurityProbe()
  let inspectorPort
  try {
    await adb(['reverse', `tcp:${metroPort}`, `tcp:${metroPort}`], {
      command: options.adb
    })
    await adb(['reverse', `tcp:${probe.port}`, `tcp:${probe.port}`], {
      command: options.adb
    })
    await proveSentinelReachability(options.adb, probe.port, probe)
    if (!options.skipInstall) {
      await adb(['install', '-r', '-t', options.apk], {
        command: options.adb,
        timeoutMs: 120_000
      })
    }
    await launchExactApp(options.adb, probe, options.devClientUrl)
    const pid = await waitForProcess(options.adb)
    const socketName = await waitForWebViewSocket(options.adb, pid)
    inspectorPort = await forwardInspector(options.adb, socketName)
    const discoveryUrl = `http://127.0.0.1:${inspectorPort}`
    const document = await waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: options.expectedText,
      timeoutMs: 60_000
    })
    const network = await verifyHostedWebViewNetworkIsolation({
      document,
      probeId: probe.token
    })
    const navigation = await verifyHostedWebViewNavigationIsolation({
      document,
      probeId: probe.token
    })
    const executable = await verifyHostedWebViewExecutableIsolation({
      document,
      probeId: probe.token
    })
    const privacy = await verifyHostedWebViewPrivacyIsolation({ document })
    if (probe.observations.length > 0) {
      throw new Error(
        `Hosted Android WebView reached the sentinel: ${probe.observations.join(', ')}`
      )
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          pid,
          href: document.href,
          sentinelRedCheck: 'observed_then_cleared',
          network,
          navigation,
          executable,
          privacy,
          sentinelObservations: probe.observations
        },
        null,
        2
      )
    )
  } finally {
    if (inspectorPort) {
      await adb(['forward', '--remove', `tcp:${inspectorPort}`], {
        command: options.adb
      }).catch(() => {})
    }
    await adb(['reverse', '--remove', `tcp:${probe.port}`], {
      command: options.adb
    }).catch(() => {})
    await probe.stop()
  }
}

function parseOptions(args) {
  const options = {
    adb: 'adb',
    apk: defaultApk,
    devClientUrl: 'exp+orca-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
    expectedText: 'mobile-rearch',
    skipInstall: false
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--adb') {
      options.adb = requireValue(args, ++index, arg)
    } else if (arg === '--apk') {
      options.apk = path.resolve(requireValue(args, ++index, arg))
    } else if (arg === '--dev-client-url') {
      options.devClientUrl = requireValue(args, ++index, arg)
    } else if (arg === '--expected-text') {
      options.expectedText = requireValue(args, ++index, arg)
    } else if (arg === '--skip-install') {
      options.skipInstall = true
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
