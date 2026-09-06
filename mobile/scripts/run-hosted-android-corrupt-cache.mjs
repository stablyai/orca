#!/usr/bin/env node

import { spawn } from 'node:child_process'
import process from 'node:process'
import { HOSTED_MOBILE_APP_ROUTE_URL } from './hosted-mobile-e2e-launch.mjs'
import {
  readSingleAndroidActivation,
  runAndroidAdb,
  waitForAndroidActivation
} from './hosted-android-mobile-web-cache.mjs'
import {
  readHostedWebViewState,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'

const packageName = 'com.stably.orca.mobile'
const activity = `${packageName}/.MainActivity`
const corruptPrimary = 'f'.repeat(64)
const corruptAlternate = 'e'.repeat(64)

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const initial = await readSingleAndroidActivation(options.adb)
  if (initial.previous) {
    throw new Error('Android corrupt-cache drill requires one active generation')
  }
  const hostRoot = initial.path.slice(0, -'/activation.json'.length)
  const corruptBuildId = initial.active === corruptPrimary ? corruptAlternate : corruptPrimary
  let inspectorPort
  let desktopPaused = false
  let fixturePrepared = false
  try {
    await prepareCorruptFixture(options.adb, hostRoot, initial.active, corruptBuildId)
    fixturePrepared = true
    process.kill(options.desktopPid, 'SIGSTOP')
    desktopPaused = true
    await launchApp(options)
    const activation = await waitForAndroidActivation(
      options.adb,
      initial.path,
      initial.active,
      options.timeoutMs
    )
    await requireGenerationRemoved(options.adb, hostRoot, corruptBuildId)
    fixturePrepared = false
    const inspector = await waitForInspector(options.adb, options.timeoutMs)
    inspectorPort = inspector.port
    const document = await waitForVisibleHostedWebView({
      discoveryUrl: `http://127.0.0.1:${inspector.port}`,
      expectedText: options.expectedText,
      timeoutMs: options.timeoutMs
    })
    const state = await readHostedWebViewState(document)
    console.log(
      JSON.stringify(
        {
          ok: true,
          pid: inspector.pid,
          corruptBuildId,
          activation,
          document: {
            targetId: document.targetId,
            href: document.href,
            bridgeListening: document.bridgeListening,
            text: state.bodyText.slice(0, 240)
          }
        },
        null,
        2
      )
    )
  } finally {
    if (desktopPaused) {
      process.kill(options.desktopPid, 'SIGCONT')
    }
    if (inspectorPort) {
      await runAndroidAdb(options.adb, ['forward', '--remove', `tcp:${inspectorPort}`]).catch(
        () => {}
      )
    }
    if (fixturePrepared) {
      await repairFixture(options.adb, hostRoot, initial.active, corruptBuildId)
    }
  }
}

async function prepareCorruptFixture(command, hostRoot, activeBuildId, corruptBuildId) {
  const generations = `${hostRoot}/generations`
  await runAndroidAdb(command, [
    'shell',
    'run-as',
    packageName,
    'cp',
    '-R',
    `${generations}/${activeBuildId}`,
    `${generations}/${corruptBuildId}`
  ])
  await adbWithInput(
    command,
    ['shell', 'run-as', packageName, 'tee', `${generations}/${corruptBuildId}/index.html`],
    '<!doctype html><title>corrupt Android active generation</title>'
  )
  await writeActivation(command, `${hostRoot}/activation.json`, {
    active: corruptBuildId,
    previous: activeBuildId
  })
}

async function repairFixture(command, hostRoot, activeBuildId, corruptBuildId) {
  await writeActivation(command, `${hostRoot}/activation.json`, {
    active: activeBuildId
  }).catch(() => {})
  await runAndroidAdb(command, [
    'shell',
    'run-as',
    packageName,
    'rm',
    '-r',
    `${hostRoot}/generations/${corruptBuildId}`
  ]).catch(() => {})
}

async function writeActivation(command, path, value) {
  await adbWithInput(command, ['shell', 'run-as', packageName, 'tee', path], JSON.stringify(value))
}

async function requireGenerationRemoved(command, hostRoot, buildId) {
  const output = await runAndroidAdb(command, [
    'shell',
    'run-as',
    packageName,
    'find',
    `${hostRoot}/generations`,
    '-mindepth',
    '1',
    '-maxdepth',
    '1',
    '-type',
    'd',
    '-name',
    buildId
  ])
  if (output) {
    throw new Error('Android corrupt active generation was not removed')
  }
}

async function launchApp(options) {
  await runAndroidAdb(options.adb, ['shell', 'am', 'force-stop', packageName])
  await runAndroidAdb(
    options.adb,
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
      options.devClientUrl
    ],
    60_000
  )
  await delay(2_000)
  await runAndroidAdb(options.adb, [
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-c',
    'android.intent.category.BROWSABLE',
    '-d',
    HOSTED_MOBILE_APP_ROUTE_URL,
    activity
  ])
}

async function waitForInspector(command, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = 'Android app process is unavailable'
  while (Date.now() < deadline) {
    try {
      const pid = await runAndroidAdb(command, ['shell', 'pidof', packageName])
      if (!/^\d+$/u.test(pid)) {
        throw new Error('Android app process is unavailable')
      }
      const portValue = await runAndroidAdb(command, [
        'forward',
        'tcp:0',
        `localabstract:webview_devtools_remote_${pid}`
      ])
      const port = Number.parseInt(portValue, 10)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Invalid Android inspector port: ${portValue}`)
      }
      return { pid, port }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
      await delay(250)
    }
  }
  throw new Error(`Android WebView inspector was unavailable: ${last}`)
}

function adbWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Android cache mutation failed: ${stderr || `exit ${code}`}`))
      }
    })
    child.stdin.end(input)
  })
}

function parseOptions(args) {
  const options = {
    adb: 'adb',
    desktopPid: 0,
    devClientUrl: 'exp+orca-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
    expectedText: 'Host 1',
    timeoutMs: 30_000
  }
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === '--') {
      continue
    } else if (option === '--adb') {
      options.adb = requireValue(args, ++index, option)
    } else if (option === '--desktop-pid') {
      options.desktopPid = Number.parseInt(requireValue(args, ++index, option), 10)
    } else if (option === '--dev-client-url') {
      options.devClientUrl = requireValue(args, ++index, option)
    } else if (option === '--expected-text') {
      options.expectedText = requireValue(args, ++index, option)
    } else if (option === '--timeout-ms') {
      options.timeoutMs = Number.parseInt(requireValue(args, ++index, option), 10)
    } else {
      throw new Error(`Unknown option: ${option}`)
    }
  }
  if (process.platform === 'win32') {
    throw new Error('Android offline corrupt-cache automation requires POSIX process signals')
  }
  if (!Number.isInteger(options.desktopPid) || options.desktopPid < 1) {
    throw new Error('--desktop-pid requires a positive integer')
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be an integer of at least 1000')
  }
  return options
}

function requireValue(args, index, option) {
  if (!args[index]) {
    throw new Error(`${option} requires a value`)
  }
  return args[index]
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
