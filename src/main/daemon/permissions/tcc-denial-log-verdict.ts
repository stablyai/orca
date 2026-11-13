// macOS's own record of a terminal-host folder denial: tccd decisions and kernel sandbox denies.

import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import type { MacTccFolderClass } from '../../../shared/daemon-adoption-telemetry'
import type {
  TccAsked,
  TccAuthReason,
  TccAuthValue,
  TccLogAccess,
  TccService,
  YesNo
} from '../../../shared/daemon-tcc-denial-capture'
import { TCC_AUTH_REASONS } from '../../../shared/daemon-tcc-denial-capture'

const LOG_LOOKBACK_MS = 10_000
const LOG_TIMEOUT_MS = 5_000
const LOG_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_KEPT_LINES = 150
const MAX_KEPT_LINE_CHARS = 1_500
const LOG_PREDICATE = '(subsystem == "com.apple.TCC") OR (sender == "Sandbox")'

export type TccLogVerdict = {
  logAccess: TccLogAccess
  tccdAsked: TccAsked
  authValue: TccAuthValue
  authReason: TccAuthReason
  service: TccService
  requirementFailure: YesNo
  kernelDeny: YesNo
  /** Raw filtered lines for the local diagnostics file only; they carry paths. */
  lines: string[]
}

export type TccLogSubject = {
  helperPid: number
  /** Helper executable path; tccd names it in attribution lines. */
  helperPath: string | null
  /** Code identifier tccd reports for both the app and its helper. */
  appId: string
  cwdClass: MacTccFolderClass
}

type LogRecord = { line: string; message: string; msgId: string | null }

type MsgGroup = {
  relevant: boolean
  service: string | null
  result: { authValue: string; authReason: string } | null
}

const LOG_ENTRY_SCHEMA = z.object({
  eventMessage: z.string(),
  processImagePath: z.string().optional(),
  processID: z.number().optional(),
  timestamp: z.string().optional()
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
  const { eventMessage: message, processImagePath: image = '' } = entry.data
  const processName = image.slice(image.lastIndexOf('/') + 1)
  const line = `${entry.data.timestamp ?? ''} ${processName}[${entry.data.processID ?? ''}] ${message}`
  return {
    line: line.length > MAX_KEPT_LINE_CHARS ? `${line.slice(0, MAX_KEPT_LINE_CHARS)}…` : line,
    message,
    msgId: MSG_ID_PATTERN.exec(message)?.[1] ?? null
  }
}

function isRequirementFailure(message: string, subject: TccLogSubject): boolean {
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

/** Keep only lines about the helper, then derive the enums; `stdout` is `log show --style ndjson`. */
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

  const kept: string[] = []
  let kernelDeny = false
  let requirementFailure = false
  for (const record of records) {
    const inRelevantGroup = record.msgId !== null && groups.get(record.msgId)?.relevant === true
    const deny = sandboxDeny.test(record.message)
    const requirement = isRequirementFailure(record.message, subject)
    if (!inRelevantGroup && !deny && !requirement && !namesHelper(record.message)) {
      continue
    }
    kernelDeny ||= deny
    requirementFailure ||= requirement
    if (kept.length < MAX_KEPT_LINES) {
      kept.push(record.line)
    }
  }

  const relevantGroups = [...groups.values()].filter((group) => group.relevant)
  const decided = relevantGroups.filter((group) => group.result !== null)
  const chosen =
    decided.findLast(
      (group) => group.service !== null && SERVICE_BY_NAME[group.service] === subject.cwdClass
    ) ??
    decided.at(-1) ??
    relevantGroups.at(-1)
  const serviceName = chosen?.service ?? null

  return {
    logAccess,
    // Only a complete read can show that tccd was never asked.
    tccdAsked: relevantGroups.length > 0 ? 'yes' : logAccess === 'ok' ? 'no' : 'unknown',
    authValue: chosen?.result ? (AUTH_VALUE_BY_NUMBER[chosen.result.authValue] ?? 'other') : 'none',
    authReason: authReasonOf(chosen?.result?.authReason),
    service: serviceName === null ? 'none' : (SERVICE_BY_NAME[serviceName] ?? 'other'),
    requirementFailure: requirementFailure ? 'yes' : 'no',
    kernelDeny: kernelDeny ? 'yes' : 'no',
    lines: kept
  }
}

function formatLogStart(atMs: number): string {
  // `log show --start` accepts "YYYY-MM-DD HH:MM:SS+ZZZZ".
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
  run: typeof runProcess = runProcess
): Promise<TccLogVerdict> {
  let logAccess: TccLogAccess
  let stdout = ''
  try {
    const result = await run({
      program: '/usr/bin/log',
      args: [
        'show',
        '--style',
        'ndjson',
        '--start',
        formatLogStart(denialAtMs - LOG_LOOKBACK_MS),
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
