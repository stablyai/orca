// macOS's own record of a terminal-host folder denial: tccd decisions and kernel sandbox denies.

import type { runProcess } from '@orca/process-host'
import { z } from 'zod'
import type { MacTccFolderClass } from '../../../shared/daemon-adoption-telemetry'
import type {
  TccAsked,
  TccAuthReason,
  TccAuthValue,
  TccLogAccess,
  RequirementFailure,
  TccService,
  YesNo
} from '../../../shared/daemon-tcc-denial-capture'
import { TCC_AUTH_REASONS } from '../../../shared/daemon-tcc-denial-capture'

// A prompted request logs its attribution long before its result; 30 s keeps both in one window.
const LOG_LOOKBACK_MS = 30_000
// End near the denial so later requests of the same class cannot replace its verdict.
const LOG_LOOKAHEAD_MS = 2_000
const LOG_TIMEOUT_MS = 5_000
const LOG_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const LOG_PREDICATE = '(subsystem == "com.apple.TCC") OR (sender == "Sandbox")'

export type TccLogVerdict = {
  logAccess: TccLogAccess
  tccdAsked: TccAsked
  authValue: TccAuthValue
  authReason: TccAuthReason
  service: TccService
  requirementFailure: RequirementFailure
  kernelDeny: YesNo
}

export type TccLogSubject = {
  helperPid: number
  /** Helper executable path; tccd names it in attribution lines. */
  helperPath: string | null
  /** Code identifier tccd reports for both the app and its helper. */
  appId: string
  cwdClass: MacTccFolderClass
}

type LogRecord = { message: string; msgId: string | null }

type MsgGroup = {
  relevant: boolean
  service: string | null
  result: { authValue: string; authReason: string } | null
}

const LOG_ENTRY_SCHEMA = z.object({
  eventMessage: z.string()
})
const MSG_ID_PATTERN = /\bmsgID=(\d+\.\d+)/
const ANY_PID_PATTERN = /\bpid=\d+/
const SERVICE_PATTERN = /\bservice=kTCCService(\w+)/
const RESULT_PATTERN = /AUTHREQ_RESULT: .*\bauthValue=(\d+), authReason=(\d+)/
const REQUIREMENT_FAILURE_PATTERN = /failed to match existing code requirement/i
const STATIC_REQUIREMENT_CHECK_PATTERN =
  /matchesCodeRequirement:\]: .* from (.+?) : (.+); status: (-?\d+)/

const SERVICE_BY_NAME: Record<string, TccService> = {
  SystemPolicyDocumentsFolder: 'documents',
  SystemPolicyDesktopFolder: 'desktop',
  SystemPolicyDownloadsFolder: 'downloads',
  SystemPolicyAllFiles: 'all_files'
}

const AUTH_VALUE_BY_NUMBER: Record<string, TccAuthValue> = {
  '0': 'denied',
  '1': 'unknown',
  '2': 'allowed',
  '3': 'limited'
}

function toRecord(rawLine: string): LogRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawLine)
  } catch {
    return null
  }
  const entry = LOG_ENTRY_SCHEMA.safeParse(parsed)
  if (!entry.success) {
    return null
  }
  const message = entry.data.eventMessage
  return { message, msgId: MSG_ID_PATTERN.exec(message)?.[1] ?? null }
}

/** A failed requirement check for this code identity; the app and its hosts share it. */
function isIdentityRequirementFailure(message: string, subject: TccLogSubject): boolean {
  if (REQUIREMENT_FAILURE_PATTERN.test(message)) {
    return (
      new RegExp(`\\bsubject ${subject.appId.replace(/\./g, '\\.')}\\b`).test(message) ||
      (!!subject.helperPath && message.includes(subject.helperPath))
    )
  }
  // tccd also checks "anchor apple" on every client; only a failed stored requirement counts.
  const check = STATIC_REQUIREMENT_CHECK_PATTERN.exec(message)
  return (
    !!check &&
    (check[1] === subject.appId || check[1] === subject.helperPath) &&
    check[2].trim() !== 'anchor apple' &&
    check[3] !== '0'
  )
}

function authReasonOf(raw: string | undefined): TccAuthReason {
  if (raw === undefined) {
    return 'none'
  }
  return TCC_AUTH_REASONS.find((reason) => reason === raw) ?? 'other'
}

/** Derive enums from lines about the helper; raw `log show --style ndjson` text is never kept. */
export function parseTccLogVerdict(
  stdout: string,
  subject: TccLogSubject,
  logAccess: TccLogAccess
): TccLogVerdict {
  const pidPattern = new RegExp(`\\bpid=${subject.helperPid}\\b`)
  const pathNeedles = subject.helperPath ? [subject.helperPath, encodeURI(subject.helperPath)] : []
  // An earlier incarnation of the same copy shares the path, so an explicit pid outranks it.
  const namesHelper = (message: string): boolean =>
    pidPattern.test(message) ||
    (!ANY_PID_PATTERN.test(message) && pathNeedles.some((needle) => message.includes(needle)))
  // Sandbox coalesces repeats as "N duplicate reports for Sandbox: …"; folder denies add "System Policy:".
  const sandboxDeny = new RegExp(
    `Sandbox: [^\\n]*?\\(${subject.helperPid}\\) (?:System Policy: )?deny\\(`
  )

  const records = stdout
    .split('\n')
    .map(toRecord)
    .filter((record): record is LogRecord => record !== null)
  const groups = new Map<string, MsgGroup>()
  for (const record of records) {
    if (!record.msgId) {
      continue
    }
    const group = groups.get(record.msgId) ?? { relevant: false, service: null, result: null }
    groups.set(record.msgId, group)
    group.relevant ||= namesHelper(record.message)
    group.service ??= SERVICE_PATTERN.exec(record.message)?.[1] ?? null
    const result = RESULT_PATTERN.exec(record.message)
    if (result) {
      group.result = { authValue: result[1], authReason: result[2] }
    }
  }

  let kernelDeny = false
  let requirementFailure: RequirementFailure = 'no'
  for (const record of records) {
    const inRelevantGroup = record.msgId !== null && groups.get(record.msgId)?.relevant === true
    const deny = sandboxDeny.test(record.message)
    const helperRecord = inRelevantGroup || namesHelper(record.message)
    const requirement = isIdentityRequirementFailure(record.message, subject)
    if (!helperRecord && !deny && !requirement) {
      continue
    }
    kernelDeny ||= deny
    if (requirement) {
      // Identifier-only evidence may be the app's or another host's check, so it is not blamed here.
      requirementFailure = helperRecord
        ? 'yes'
        : requirementFailure === 'yes'
          ? 'yes'
          : 'uncorrelated'
    }
  }

  const relevantGroups = [...groups.values()].filter((group) => group.relevant)
  const decided = relevantGroups.filter((group) => group.result !== null)
  // Overlapping requests can resolve out of order; a later "allowed" must not mask a denial.
  const denied = decided.filter((group) => group.result?.authValue === '0')
  const chosen =
    denied.findLast(
      (group) => group.service !== null && SERVICE_BY_NAME[group.service] === subject.cwdClass
    ) ??
    decided.findLast(
      (group) => group.service !== null && SERVICE_BY_NAME[group.service] === subject.cwdClass
    ) ??
    decided.at(-1) ??
    relevantGroups.at(-1)
  const serviceName = chosen?.service ?? null

  return {
    logAccess,
    // "no" means no request tied to this helper in the window, and only from a complete read.
    tccdAsked: relevantGroups.length > 0 ? 'yes' : logAccess === 'ok' ? 'no' : 'unknown',
    authValue: chosen?.result ? (AUTH_VALUE_BY_NUMBER[chosen.result.authValue] ?? 'other') : 'none',
    authReason: authReasonOf(chosen?.result?.authReason),
    service: serviceName === null ? 'none' : (SERVICE_BY_NAME[serviceName] ?? 'other'),
    requirementFailure,
    kernelDeny: kernelDeny ? 'yes' : 'no'
  }
}

function formatLogTime(atMs: number): string {
  // `log show --start/--end` accept "YYYY-MM-DD HH:MM:SS+ZZZZ".
  const iso = new Date(atMs).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+0000`
}

function classifyLogFailure(output: string): TccLogAccess {
  return /must be admin|not permitted|permission denied/i.test(output) ? 'denied' : 'error'
}

/** Bounded `log show` around the denial; never throws. */
export async function readTccLogVerdict(
  denialAtMs: number,
  subject: TccLogSubject,
  run: typeof runProcess
): Promise<TccLogVerdict> {
  let logAccess: TccLogAccess
  let stdout = ''
  try {
    const result = await run({
      program: '/usr/bin/log',
      args: [
        'show',
        // Requirement checks (matchesCodeRequirement) are Info records.
        '--info',
        '--style',
        'ndjson',
        '--start',
        formatLogTime(denialAtMs - LOG_LOOKBACK_MS),
        '--end',
        formatLogTime(denialAtMs + LOG_LOOKAHEAD_MS),
        '--predicate',
        LOG_PREDICATE
      ],
      timeoutMs: LOG_TIMEOUT_MS,
      maxOutputBytes: LOG_MAX_OUTPUT_BYTES,
      killOnOutputLimit: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    stdout = result.stdout
    logAccess = result.timedOut
      ? 'timeout'
      : result.outputTruncated
        ? 'truncated'
        : result.code === 0
          ? 'ok'
          : classifyLogFailure(`${result.stderr}\n${result.stdout}`)
  } catch {
    logAccess = 'error'
  }
  // A killed `log show` still printed complete lines before its deadline.
  return parseTccLogVerdict(stdout, subject, logAccess)
}
