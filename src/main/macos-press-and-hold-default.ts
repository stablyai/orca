import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { writeFileAtomically } from './codex-accounts/fs-utils'

// Opt out of the accent picker once so terminal keys repeat (#14746); later user choices win.
// The separate defaults process may affect only the next launch. Reverting this also requires deleting the key.

export const PRESS_AND_HOLD_KEY = 'ApplePressAndHoldEnabled'
export const PRESS_AND_HOLD_RECORD_FILE = 'macos-press-and-hold-default.json'
export const PRESS_AND_HOLD_RECORD_VERSION = 1

// defaults read distinguishes an absent key from explicit false; systemPreferences.getUserDefault cannot.
const DEFAULTS_BINARY = '/usr/bin/defaults'
// This runs before ready; bound a wedged defaults process more tightly than the shared 30s timeout.
const DEFAULTS_TIMEOUT_MS = 5_000
// defaults uses exit 1 for an absent key; other failures leave its presence unknown.
const DEFAULTS_MISSING_STATUS = 1

const ORCA_BUNDLE_ID = 'com.stablyai.orca'

export type PressAndHoldDecision =
  | 'not-macos'
  | 'already-decided'
  | 'foreign-bundle'
  | 'probe-failed'
  | 'write-failed'
  | 'kept-user-preference'
  | 'applied'

// Transient failures are retried on later launches; completed decisions preserve user changes.
const TERMINAL_DECISIONS = new Set<PressAndHoldDecision>(['applied', 'kept-user-preference'])

export type PressAndHoldRecord = {
  version: number
  decision: PressAndHoldDecision
  domain: string | null
  decidedAt: string
}

export type PressAndHoldHost = {
  platform: NodeJS.Platform
  resolveBundleIdentifier: () => string | null
  readRecord: () => PressAndHoldRecord | null
  writeRecord: (record: PressAndHoldRecord) => void
  readDomainPreference: (domain: string) => 'set' | 'unset' | 'unknown'
  writeDomainPreference: (domain: string, value: boolean) => boolean
  now: () => string
}

// Unpackaged Electron apps share com.github.Electron; do not change that domain.
export function isOrcaPreferencesDomain(domain: string): boolean {
  return domain === ORCA_BUNDLE_ID || domain.startsWith(`${ORCA_BUNDLE_ID}.`)
}

export function readBundleIdentifierFromExecutablePath(execPath: string): string | null {
  try {
    const plist = readFileSync(join(dirname(dirname(execPath)), 'Info.plist'), 'utf8')
    const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)
    const identifier = match?.[1]?.trim()
    return identifier ? identifier : null
  } catch {
    return null
  }
}

/** Failed probes cannot establish absence and must never authorize overwriting a preference. */
export function interpretDefaultsRead(probe: () => ProcessResult): 'set' | 'unset' | 'unknown' {
  let result: ProcessResult
  try {
    result = probe()
  } catch {
    return 'unknown'
  }
  // A timeout invalidates any exit status from the interrupted probe.
  if (result.timedOut) {
    return 'unknown'
  }
  if (result.code === 0) {
    return 'set'
  }
  return result.code === DEFAULTS_MISSING_STATUS ? 'unset' : 'unknown'
}

export function readDomainPressAndHoldPreference(domain: string): 'set' | 'unset' | 'unknown' {
  // Presence alone preserves both explicit true and explicit false as user choices.
  return interpretDefaultsRead(() =>
    runProcessSync({
      program: DEFAULTS_BINARY,
      args: ['read', domain, PRESS_AND_HOLD_KEY],
      timeoutMs: DEFAULTS_TIMEOUT_MS,
      stdio: ['ignore', 'ignore', 'ignore']
    })
  )
}

export function writeDomainPressAndHoldPreference(domain: string, value: boolean): boolean {
  try {
    return (
      runProcessSync({
        program: DEFAULTS_BINARY,
        args: ['write', domain, PRESS_AND_HOLD_KEY, '-bool', value ? 'true' : 'false'],
        timeoutMs: DEFAULTS_TIMEOUT_MS,
        stdio: ['ignore', 'ignore', 'ignore']
      }).code === 0
    )
  } catch {
    return false
  }
}

export function pressAndHoldRecordPath(userDataPath: string): string {
  return join(userDataPath, PRESS_AND_HOLD_RECORD_FILE)
}

function parseRecord(raw: string): PressAndHoldRecord | null {
  const parsed = JSON.parse(raw) as Partial<PressAndHoldRecord>
  if (parsed.version !== PRESS_AND_HOLD_RECORD_VERSION || typeof parsed.decision !== 'string') {
    return null
  }
  return {
    version: PRESS_AND_HOLD_RECORD_VERSION,
    decision: parsed.decision as PressAndHoldDecision,
    domain: typeof parsed.domain === 'string' ? parsed.domain : null,
    decidedAt: typeof parsed.decidedAt === 'string' ? parsed.decidedAt : ''
  }
}

export function ensureMacPressAndHoldDefault(host: PressAndHoldHost): PressAndHoldDecision {
  if (host.platform !== 'darwin') {
    return 'not-macos'
  }

  const previous = host.readRecord()
  if (previous && TERMINAL_DECISIONS.has(previous.decision)) {
    return 'already-decided'
  }

  const record = (decision: PressAndHoldDecision, domain: string | null): PressAndHoldDecision => {
    // Transient decisions recur on every launch; persist only changed results.
    if (!previous || previous.decision !== decision || previous.domain !== domain) {
      host.writeRecord({
        version: PRESS_AND_HOLD_RECORD_VERSION,
        decision,
        domain,
        decidedAt: host.now()
      })
    }
    return decision
  }

  const domain = host.resolveBundleIdentifier()
  if (!domain || !isOrcaPreferencesDomain(domain)) {
    return record('foreign-bundle', domain)
  }

  const existing = host.readDomainPreference(domain)
  if (existing === 'unknown') {
    return record('probe-failed', domain)
  }
  if (existing === 'set') {
    return record('kept-user-preference', domain)
  }
  if (!host.writeDomainPreference(domain, false)) {
    return record('write-failed', domain)
  }
  return record('applied', domain)
}

const REPORTED_DECISIONS: Partial<Record<PressAndHoldDecision, string>> = {
  applied: `set ${PRESS_AND_HOLD_KEY}=false so held keys repeat; takes effect next launch`,
  'probe-failed': `could not read ${PRESS_AND_HOLD_KEY}; leaving it alone`,
  'write-failed': `could not write ${PRESS_AND_HOLD_KEY}; held keys will not repeat`
}

export function applyMacPressAndHoldDefaultAtStartup(userDataPath: string): PressAndHoldDecision {
  const recordPath = pressAndHoldRecordPath(userDataPath)
  const decision = ensureMacPressAndHoldDefault({
    platform: process.platform,
    resolveBundleIdentifier: () => readBundleIdentifierFromExecutablePath(process.execPath),
    readRecord: () => {
      try {
        return parseRecord(readFileSync(recordPath, 'utf8'))
      } catch {
        return null
      }
    },
    writeRecord: (record) => {
      try {
        // Before ready, Electron may not have created userData yet.
        mkdirSync(userDataPath, { recursive: true })
        writeFileAtomically(recordPath, `${JSON.stringify(record, null, 2)}\n`)
      } catch {
        // If persistence fails, a later launch safely probes the preference again.
      }
    },
    readDomainPreference: readDomainPressAndHoldPreference,
    writeDomainPreference: writeDomainPressAndHoldPreference,
    now: () => new Date().toISOString()
  })
  const reported = REPORTED_DECISIONS[decision]
  if (reported) {
    console.log(`[press-and-hold] ${reported}`)
  }
  return decision
}
