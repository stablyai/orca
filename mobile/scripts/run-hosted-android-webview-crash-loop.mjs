#!/usr/bin/env node

import process from 'node:process'
import {
  readHostedWebViewState,
  terminateHostedWebViewProcess,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import {
  readAndroidRollbackActivation,
  runAndroidAdb,
  waitForAndroidActivation
} from './hosted-android-mobile-web-cache.mjs'

const packageName = 'com.stably.orca.mobile'
const failureCount = 3

async function forwardInspector(command) {
  const pid = await runAndroidAdb(command, ['shell', 'pidof', packageName])
  if (!/^\d+$/u.test(pid)) {
    throw new Error('Android app process is unavailable')
  }
  const socket = `webview_devtools_remote_${pid}`
  const portValue = await runAndroidAdb(command, ['forward', 'tcp:0', `localabstract:${socket}`])
  const port = Number.parseInt(portValue, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid Android inspector port: ${portValue}`)
  }
  return { pid, port }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const initial = await readAndroidRollbackActivation(options.adb)
  const inspector = await forwardInspector(options.adb)
  const discoveryUrl = `http://127.0.0.1:${inspector.port}`
  const documents = []
  const startedAt = Date.now()
  try {
    let document = await waitForVisibleHostedWebView({
      discoveryUrl,
      expectedText: options.expectedText,
      timeoutMs: options.timeoutMs
    })
    documents.push({ targetId: document.targetId, href: document.href })
    for (let index = 0; index < failureCount; index += 1) {
      const priorTargetId = document.targetId
      await terminateHostedWebViewProcess(document)
      document = await waitForVisibleHostedWebView({
        discoveryUrl,
        expectedText: options.expectedText,
        timeoutMs: options.timeoutMs
      })
      if (document.targetId === priorTargetId) {
        throw new Error('Android WebView process did not remount')
      }
      documents.push({ targetId: document.targetId, href: document.href })
    }
    const finalActivation = await waitForAndroidActivation(
      options.adb,
      initial.path,
      initial.previous,
      options.timeoutMs
    )
    const finalDocument = await readHostedWebViewState(document)
    if (Date.now() - startedAt >= 60_000) {
      throw new Error('Android crash-loop drill exceeded the production failure window')
    }
    if (documents.at(-1)?.href === documents[0]?.href) {
      throw new Error('Android rollback did not open a new native package session')
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          pid: inspector.pid,
          failures: failureCount,
          durationMs: Date.now() - startedAt,
          initial: { active: initial.active, previous: initial.previous },
          finalActivation,
          documents,
          finalText: finalDocument.bodyText.slice(0, 240)
        },
        null,
        2
      )
    )
  } finally {
    await runAndroidAdb(options.adb, ['forward', '--remove', `tcp:${inspector.port}`]).catch(
      () => {}
    )
  }
}

function parseOptions(args) {
  const options = { adb: 'adb', expectedText: 'mobile-rearch', timeoutMs: 30_000 }
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === '--adb') {
      options.adb = requireValue(args, ++index, option)
    } else if (option === '--expected-text') {
      options.expectedText = requireValue(args, ++index, option)
    } else if (option === '--timeout-ms') {
      options.timeoutMs = Number.parseInt(requireValue(args, ++index, option), 10)
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
        throw new Error('--timeout-ms must be an integer of at least 1000')
      }
    } else {
      throw new Error(`Unknown option: ${option}`)
    }
  }
  return options
}

function requireValue(args, index, option) {
  if (!args[index]) {
    throw new Error(`${option} requires a value`)
  }
  return args[index]
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
