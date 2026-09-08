import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hostedWebViewPrivacyLogEvidence } from './hosted-webview-privacy-log-evidence.mjs'

const execFileAsync = promisify(execFile)

export async function verifyHostedIosPrivacyLogs({ deviceUdid, startedAt }) {
  const { stdout } = await execFileAsync(
    'xcrun',
    [
      'simctl',
      'spawn',
      deviceUdid,
      'log',
      'show',
      '--start',
      hostedIosLogStartTime(startedAt),
      '--style',
      'compact',
      '--predicate',
      'process == "Orca"'
    ],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000
    }
  )
  return hostedIosPrivacyLogEvidence(stdout)
}

export function hostedIosLogStartTime(value) {
  const date = new Date(value)
  const part = (number) => String(number).padStart(2, '0')
  return `${[date.getFullYear(), part(date.getMonth() + 1), part(date.getDate())].join('-')} ${part(
    date.getHours()
  )}:${part(date.getMinutes())}:${part(date.getSeconds())}`
}

export function hostedIosPrivacyLogEvidence(source) {
  return hostedWebViewPrivacyLogEvidence(source, 'iOS')
}
