import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { waitForHostedIosAccessibilityLabel } from './hosted-ios-emulator-accessibility.mjs'
import { evaluateHostedDocumentWithRetry } from './hosted-webview-cdp-session.mjs'

const execFileAsync = promisify(execFile)
const BLOCKED_WARNING_LABEL = 'Navigation outside Orca was blocked.'
const EXTERNAL_ORIGIN = 'https://example.com/'
const LOG_PREDICATE =
  'senderImagePath CONTAINS "WebKit" OR process == "Orca" OR process CONTAINS "com.apple.WebKit"'

// The shell once set limitsNavigationsToAppBoundDomains with no WKAppBoundDomains key; an A/B
// rebuild showed it inert and the flag was removed. This probe stays as the regression check that
// the shell's own navigation delegate is what refuses external navigation: the delegate raises
// onNavigationBlocked (a native warning banner), while an app-bound refusal would fail the
// provisional navigation inside WebKit with no delegate decision.
export async function probeHostedIosAppBoundNavigation(
  { deviceUdid, emulator, sessionDocument, timeoutMs },
  operations = {}
) {
  const evaluate = operations.evaluate ?? evaluateHostedDocumentWithRetry
  const waitForLabel = operations.waitForLabel ?? waitForHostedIosAccessibilityLabel
  const collectLog = operations.collectLog ?? collectSimulatorLog

  const before = await readDocumentIdentity(sessionDocument, evaluate)
  const logStart = new Date()
  await requestExternalNavigation(sessionDocument, evaluate)
  const warning = await waitForBlockedWarning(emulator, waitForLabel, timeoutMs)
  const after = await readDocumentIdentity(sessionDocument, evaluate)
  const log = await collectLog(deviceUdid, logStart)

  return {
    appBoundLogLines: log.filter((line) => /app-?bound/i.test(line)).slice(0, 20),
    blockedWarningObserved: warning,
    documentRetained: after.href === before.href && after.origin === before.origin,
    externalOrigin: EXTERNAL_ORIGIN,
    hrefAfter: after.href,
    hrefBefore: before.href,
    webKitLogLines: log.slice(0, 40)
  }
}

async function requestExternalNavigation(document, evaluate) {
  const expression = `(() => {
    try {
      location.href = ${JSON.stringify(EXTERNAL_ORIGIN)};
      return JSON.stringify({ requested: true, error: null });
    } catch (error) {
      return JSON.stringify({ requested: false, error: String(error).slice(0, 240) });
    }
  })()`
  const result = JSON.parse(await evaluate(document, expression))
  if (result?.requested !== true) {
    throw new Error(`App-bound navigation probe could not request a navigation: ${result?.error}`)
  }
}

async function readDocumentIdentity(document, evaluate) {
  const expression = `JSON.stringify({
    href: String(location.href).slice(0, 2048),
    origin: String(location.origin).slice(0, 512)
  })`
  return JSON.parse(await evaluate(document, expression))
}

async function waitForBlockedWarning(emulator, waitForLabel, timeoutMs) {
  try {
    await waitForLabel(emulator, BLOCKED_WARNING_LABEL, Math.min(timeoutMs, 30_000))
    return true
  } catch {
    return false
  }
}

async function collectSimulatorLog(deviceUdid, since) {
  const { stdout } = await execFileAsync(
    'xcrun',
    [
      'simctl',
      'spawn',
      deviceUdid,
      'log',
      'show',
      '--style',
      'compact',
      '--start',
      formatLogTimestamp(since),
      '--predicate',
      LOG_PREDICATE
    ],
    { maxBuffer: 32 * 1024 * 1024 }
  ).catch(() => ({ stdout: '' }))
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function formatLogTimestamp(value) {
  const pad = (part) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(
    value.getHours()
  )}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
}
