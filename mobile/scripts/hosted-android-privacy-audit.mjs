import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hostedWebViewPrivacyLogEvidence } from './hosted-webview-privacy-log-evidence.mjs'

const execFileAsync = promisify(execFile)
const packageName = 'com.stably.orca.mobile'
const failureReasons = new Set([4, 5, 6, 7, 9])
const exitRecordStart = /^\s*ApplicationExitInfo #\d+:/mu

export async function readHostedAndroidExitInfo(adb) {
  return runAdb(adb, ['shell', 'dumpsys', 'activity', 'exit-info', packageName], 8)
}

export async function verifyHostedAndroidPrivacyAudit({
  adb,
  baselineExitInfo,
  devServerPort,
  probePort
}) {
  const [logcat, exitInfo] = await Promise.all([
    runAdb(adb, ['logcat', '-d', '-v', 'threadtime'], 32),
    readHostedAndroidExitInfo(adb)
  ])
  return {
    logs: hostedAndroidPrivacyLogEvidence(logcat, { devServerPort, probePort }),
    exitInfo: hostedAndroidExitInfoEvidence(baselineExitInfo, exitInfo)
  }
}

export function hostedAndroidPrivacyLogEvidence(source, expectedDebugUrls) {
  let expectedDebugWebSocketUrls = 0
  const sanitized = source.replace(/wss?:\/\/[^\s"'<>]+/giu, (value) => {
    if (!isExpectedDebugWebSocketUrl(value, expectedDebugUrls)) {
      return value
    }
    expectedDebugWebSocketUrls += 1
    return '[expected-debug-websocket]'
  })
  return {
    ...hostedWebViewPrivacyLogEvidence(sanitized, 'Android'),
    logBytes: Buffer.byteLength(source),
    expectedDebugWebSocketUrls
  }
}

export function hostedAndroidExitInfoEvidence(baseline, current) {
  const baselineRecords = new Set(parseExitRecords(baseline))
  const newRecords = parseExitRecords(current).filter((record) => !baselineRecords.has(record))
  const privacy = hostedWebViewPrivacyLogEvidence(newRecords.join('\n'), 'Android exit-info')
  const failures = newRecords.filter((record) => failureReasons.has(exitReason(record)))
  if (failures.length > 0) {
    throw new Error(`Hosted Android exit-info recorded a process failure:\n${failures.join('\n')}`)
  }
  return {
    currentRecords: parseExitRecords(current).length,
    newRecords: newRecords.length,
    failureRecords: 0,
    reportBytes: privacy.logBytes,
    counts: privacy.counts
  }
}

function parseExitRecords(source) {
  const starts = [...source.matchAll(new RegExp(exitRecordStart.source, 'gmu'))]
  return starts.map((match, index) =>
    source
      .slice(match.index, starts[index + 1]?.index)
      .replace(/^\s*ApplicationExitInfo #\d+:\s*/u, '')
      .trim()
  )
}

function exitReason(record) {
  const value = record.match(/\breason=(\d+)\s+\(/u)?.[1]
  return value ? Number.parseInt(value, 10) : -1
}

function isExpectedDebugWebSocketUrl(value, expected) {
  if (!expected) {
    return false
  }
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (
    url.protocol === 'ws:' &&
    url.hostname === '127.0.0.1' &&
    url.port === String(expected.probePort) &&
    url.pathname === '/socket-probe' &&
    !url.search &&
    !url.hash
  ) {
    return true
  }
  const keys = [...url.searchParams.keys()].sort()
  const debugPorts = new Set([String(expected.devServerPort), '8081'])
  return (
    url.protocol === 'ws:' &&
    ['10.0.2.2', '127.0.0.1'].includes(url.hostname) &&
    debugPorts.has(url.port) &&
    url.pathname === '/message' &&
    !url.hash &&
    keys.join(',') === 'app,clientid,device' &&
    url.searchParams.get('app') === packageName &&
    ['BridgelessDevSupportManager', 'DevLauncherBridgelessDevSupportManager'].includes(
      url.searchParams.get('clientid') ?? ''
    ) &&
    /^[\w .()-]{1,160}$/u.test(url.searchParams.get('device') ?? '')
  )
}

async function runAdb(adb, args, maxBufferMiB) {
  const { stdout } = await execFileAsync(adb, args, {
    encoding: 'utf8',
    maxBuffer: maxBufferMiB * 1024 * 1024,
    timeout: 30_000
  })
  return stdout
}
