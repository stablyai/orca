import { runProcess } from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import type { SystemSleepHold } from '../shared/computer-awake-mode'

export const SLEEP_DISABLED_CACHE_MS = 5_000
const PMSET_TIMEOUT_MS = 2_000
const PMSET_MAX_OUTPUT_BYTES = 65_536
// Why: runProcess settles after its own kill grace; this outer cap keeps a wedged
// probe from holding the single-flight past that.
const PROBE_DEADLINE_MS = 4_500

type SleepDisabledState = SystemSleepHold['sleepDisabled']
type Logger = Pick<Console, 'debug' | 'warn'>

export type SystemSleepHoldReader = {
  read: () => Promise<SystemSleepHold>
  dispose: () => void
}

type ReaderOptions = {
  logger?: Logger
  now?: () => number
  platform?: NodeJS.Platform
  run?: (spec: ProcessSpec) => Promise<ProcessResult>
}

const SECTION_HEADER = /^(\S.*):\s*$/
const SYSTEM_SECTION = 'System-wide power settings'
const CURRENT_SECTION = 'Currently in use'
const SLEEP_DISABLED_LINE = /^\s*SleepDisabled\b/
const SLEEP_DISABLED_VALUE = /^\s*SleepDisabled\s+([01])\s*$/
// Why: seeing any of these under "Currently in use:" proves pmset actually read the settings.
const KNOWN_PMSET_KEYS = [
  'standby',
  'sleep',
  'displaysleep',
  'disksleep',
  'hibernatemode',
  'powernap',
  'womp',
  'ttyskeepawake',
  'lowpowermode',
  'networkoversleep',
  'tcpkeepalive',
  'Sleep On Power Button'
]

function isKnownKeyLine(line: string): boolean {
  const trimmed = line.trim()
  return KNOWN_PMSET_KEYS.some(
    (key) => trimmed.startsWith(key) && /^\s/.test(trimmed.slice(key.length))
  )
}

export function parsePmsetSleepDisabled(output: string): SleepDisabledState {
  let section: string | null = null
  let systemSectionSeen = false
  let currentSectionProven = false
  const systemSleepDisabledLines: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const header = SECTION_HEADER.exec(line)?.[1]
    if (header !== undefined) {
      section = header
      systemSectionSeen ||= header === SYSTEM_SECTION
      continue
    }
    if (SLEEP_DISABLED_LINE.test(line)) {
      if (section !== SYSTEM_SECTION) {
        return 'unknown'
      }
      systemSleepDisabledLines.push(line)
    } else if (section === CURRENT_SECTION && isKnownKeyLine(line)) {
      currentSectionProven = true
    }
  }
  if (!systemSectionSeen || systemSleepDisabledLines.length > 1) {
    return 'unknown'
  }
  const [sleepDisabledLine] = systemSleepDisabledLines
  if (sleepDisabledLine !== undefined) {
    const value = SLEEP_DISABLED_VALUE.exec(sleepDisabledLine)?.[1]
    if (value === undefined) {
      return 'unknown'
    }
    return value === '1' ? 'yes' : 'no'
  }
  // Why: macOS omits the line when sleep is not disabled, so a missing line means "no"
  // only when pmset demonstrably read the current settings, not on an error or truncation.
  return currentSectionProven ? 'no' : 'unknown'
}

export function createSystemSleepHoldReader(options: ReaderOptions = {}): SystemSleepHoldReader {
  const logger = options.logger ?? console
  const now = options.now ?? Date.now
  const platform = options.platform ?? process.platform
  const run = options.run ?? runProcess

  let cached: SystemSleepHold | null = null
  let cachedUntil = 0
  let inFlight: Promise<SystemSleepHold> | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let failureStreak = false
  let disposed = false

  const logFailure = (reason: string, detail?: unknown): void => {
    if (failureStreak) {
      logger.debug('[agent-awake] pmset SleepDisabled read failed repeatedly', { reason })
      return
    }
    failureStreak = true
    logger.warn('[agent-awake] pmset SleepDisabled read failed', { reason, detail })
  }

  const probe = async (): Promise<SleepDisabledState> => {
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        run({
          program: '/usr/bin/pmset',
          args: ['-g'],
          timeoutMs: PMSET_TIMEOUT_MS,
          maxOutputBytes: PMSET_MAX_OUTPUT_BYTES
        }),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('probe-deadline')), PROBE_DEADLINE_MS)
        })
      ])
      if (result.timedOut || result.code !== 0 || result.outputTruncated) {
        logFailure(result.timedOut ? 'timeout' : `exit-${String(result.code)}`)
        return 'unknown'
      }
      const state = parsePmsetSleepDisabled(result.stdout)
      if (state === 'unknown') {
        logFailure('unparseable-output')
      } else {
        failureStreak = false
      }
      return state
    } catch (error) {
      logFailure('spawn-error', error instanceof Error ? error.message : String(error))
      return 'unknown'
    } finally {
      if (deadline !== undefined) {
        clearTimeout(deadline)
      }
    }
  }

  const startProbe = (): Promise<SystemSleepHold> => {
    // Why: the value can only vouch for the moment the probe began; a change during the read postdates it.
    const startedAt = now()
    const flight = probe().then((sleepDisabled) => {
      const hold: SystemSleepHold = { sleepDisabled, observedAt: startedAt }
      cached = hold
      cachedUntil = startedAt + SLEEP_DISABLED_CACHE_MS
      return hold
    })
    inFlight = flight
    void flight.finally(() => {
      if (inFlight === flight) {
        inFlight = null
      }
    })
    return flight
  }

  // Why: a caller that got a cached value is told to re-ask at expiry; one re-read
  // there lets that re-ask see fresh data instead of starting its own probe late.
  const scheduleRefreshAtExpiry = (): void => {
    if (refreshTimer !== null || disposed) {
      return
    }
    const delay = Math.max(0, cachedUntil - now())
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (!disposed && inFlight === null) {
        void startProbe()
      }
    }, delay)
    refreshTimer.unref?.()
  }

  return {
    read: async () => {
      if (platform !== 'darwin') {
        return { sleepDisabled: 'unknown', observedAt: now() }
      }
      if (inFlight) {
        return inFlight
      }
      if (cached && now() < cachedUntil) {
        scheduleRefreshAtExpiry()
        return cached
      }
      return startProbe()
    },
    dispose: () => {
      disposed = true
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer)
        refreshTimer = null
      }
    }
  }
}
