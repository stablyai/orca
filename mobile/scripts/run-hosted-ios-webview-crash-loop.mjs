#!/usr/bin/env node

import { execFile } from 'node:child_process'
import net from 'node:net'
import process from 'node:process'
import { promisify } from 'node:util'
import { startCdpServer } from 'inspect-webkit'
import {
  readHostedWebViewState,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { readIosRollbackActivation, waitForIosActivation } from './hosted-ios-mobile-web-cache.mjs'
import { verifyHostedIosPrivacyLogs } from './hosted-ios-privacy-log-audit.mjs'
import { terminateHostedIosWebContent } from './hosted-ios-webcontent-process.mjs'
import { verifyHostedWebViewPrivacyIsolation } from './hosted-webview-privacy-isolation.mjs'

const execFileAsync = promisify(execFile)
const bundleIdentifier = 'com.stably.orca.mobile'
const failureCount = 3

async function simctl(args, timeoutMs = 30_000) {
  const result = await execFileAsync('xcrun', ['simctl', ...args], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: timeoutMs
  })
  return result.stdout.trim()
}

async function resolveSimulatorUdid(requested) {
  const devicesByRuntime = JSON.parse(await simctl(['list', 'devices', 'available', '-j'])).devices
  const devices = Object.values(devicesByRuntime ?? {}).flat()
  const matches = devices.filter((device) => device.udid === requested || device.name === requested)
  const selected = matches.find((device) => device.state === 'Booted') ?? matches[0]
  if (!selected?.udid) {
    throw new Error(`No available iOS Simulator matched "${requested}"`)
  }
  if (selected.state !== 'Booted') {
    throw new Error(`iOS Simulator "${requested}" is not booted`)
  }
  return selected.udid
}

async function findAvailableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('No inspector port'))
      )
    })
  })
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Hosted iOS WebView crash automation requires macOS and Xcode')
  }
  const options = parseOptions(process.argv.slice(2))
  const deviceUdid = await resolveSimulatorUdid(options.device)
  const appDataPath = await simctl(['get_app_container', deviceUdid, bundleIdentifier, 'data'])
  const initial = await readIosRollbackActivation(appDataPath)
  const inspectorPort = await findAvailableLoopbackPort()
  const inspector = await startCdpServer({ port: inspectorPort })
  const discoveryUrl = `http://127.0.0.1:${inspectorPort}`
  const documents = []
  const terminatedProcessIds = []
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
      terminatedProcessIds.push(await terminateHostedIosWebContent(deviceUdid))
      document = await waitForVisibleHostedWebView({
        discoveryUrl,
        expectedText: options.expectedText,
        timeoutMs: options.timeoutMs
      })
      if (document.targetId === priorTargetId) {
        throw new Error('iOS WebContent process did not remount')
      }
      documents.push({ targetId: document.targetId, href: document.href })
    }
    const finalActivation = await waitForIosActivation(
      initial.path,
      initial.previous,
      options.timeoutMs
    )
    const finalDocument = await readHostedWebViewState(document)
    const privacy = await verifyHostedWebViewPrivacyIsolation({ document })
    const privacyLogs = await verifyHostedIosPrivacyLogs({ deviceUdid, startedAt })
    if (Date.now() - startedAt >= 60_000) {
      throw new Error('iOS crash-loop drill exceeded the production failure window')
    }
    if (documents.at(-1)?.href === documents[0]?.href) {
      throw new Error('iOS rollback did not open a new native package session')
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          device: deviceUdid,
          failures: failureCount,
          durationMs: Date.now() - startedAt,
          terminatedProcessIds,
          initial: { active: initial.active, previous: initial.previous },
          finalActivation,
          documents,
          finalText: finalDocument.bodyText.slice(0, 240),
          privacy,
          privacyLogs
        },
        null,
        2
      )
    )
  } finally {
    inspector.stop()
  }
}

function parseOptions(args) {
  const options = {
    device: 'iPhone 17 Pro',
    expectedText: 'mobile-rearch',
    timeoutMs: 30_000
  }
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === '--') {
      continue
    }
    if (option === '--device') {
      options.device = requireValue(args, ++index, option)
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
