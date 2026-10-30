import os from 'node:os'
import { runProcess } from '@orca/process-host'
import { normalizeMachineName } from '../../shared/machine-name'
import { withTimeout } from '../../shared/promise-timeout-fallback'

const MACOS_COMPUTER_NAME = '/usr/sbin/scutil'
// Boot load can delay scutil by seconds; prefer a late correct name while publishers bound their own wait.
const MACOS_COMPUTER_NAME_TIMEOUT_MS = 5_000
const MACOS_COMPUTER_NAME_MAX_OUTPUT_BYTES = 4 * 1024
// Status probes allow 1s: answer hostname at deadline while lookup continues; later reads get the friendly name.
export const MACHINE_NAME_PUBLISH_WAIT_MS = 750
// Retry failed lookup without spawning on every status read.
export const MACHINE_NAME_RETRY_INTERVAL_MS = 30_000

type MachineNameReader = () => string | undefined

/** `final` marks an answer worth memoizing; a fallback is retried later. */
export type MachineNameDetection = { name: string; final: boolean }

export async function detectRuntimeMachineName(
  args: {
    platform?: NodeJS.Platform
    fallback?: string
    run?: typeof runProcess
  } = {}
): Promise<MachineNameDetection> {
  const platform = args.platform ?? process.platform
  const fallback = normalizeMachineName(args.fallback ?? os.hostname())
  if (platform !== 'darwin') {
    // Off macOS, hostname is the final name source.
    return { name: fallback, final: true }
  }
  try {
    const result = await (args.run ?? runProcess)({
      program: MACOS_COMPUTER_NAME,
      args: ['--get', 'ComputerName'],
      timeoutMs: MACOS_COMPUTER_NAME_TIMEOUT_MS,
      maxOutputBytes: MACOS_COMPUTER_NAME_MAX_OUTPUT_BYTES,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    })
    if (result.code === 0 && !result.timedOut) {
      const friendlyName = normalizeMachineName(result.stdout)
      if (friendlyName) {
        return { name: friendlyName, final: true }
      }
    }
  } catch {
    // Restricted or older macOS installs fall back to the hostname.
  }
  return { name: fallback, final: false }
}

// All runtimes share one host; memoize scutil once per process.
let sharedLookup: Promise<void> | null = null
/** The final answer once a lookup lands; every runtime reads it, so a retry corrects them all. */
let sharedDetectedName: string | null = null
let lastFailedLookupAt: number | null = null

function lookupSharedMachineName(): Promise<void> {
  if (sharedLookup) {
    return sharedLookup
  }
  if (
    lastFailedLookupAt !== null &&
    Date.now() - lastFailedLookupAt < MACHINE_NAME_RETRY_INTERVAL_MS
  ) {
    return Promise.resolve()
  }
  const lookup: Promise<void> = detectRuntimeMachineName().then(
    (detection) => {
      if (detection.final) {
        sharedDetectedName = detection.name
        return
      }
      recordFailedLookup(lookup)
    },
    () => {
      // detectRuntimeMachineName resolves on every path it owns; treat a surprise as a failed attempt.
      recordFailedLookup(lookup)
    }
  )
  sharedLookup = lookup
  return lookup
}

// Timeout is not host identity; retry later instead of caching hostname permanently.
function recordFailedLookup(lookup: Promise<void>): void {
  lastFailedLookupAt = Date.now()
  if (sharedLookup === lookup) {
    sharedLookup = null
  }
}

export class RuntimeMachineName {
  private readonly hostname = normalizeMachineName(os.hostname())

  constructor(private readonly readConfiguredName: MachineNameReader) {}

  /** Starts the shared lookup; `read` answers with the hostname until it lands. */
  start(): void {
    void this.ready()
  }

  /** Settles once the current lookup has landed or given up; a failed one is retried on a later call. */
  ready(): Promise<void> {
    return lookupSharedMachineName()
  }

  /** `ready`, but a publisher stops waiting after `budgetMs` and answers with what `read` has now. */
  readyWithin(budgetMs: number): Promise<void> {
    return withTimeout(this.ready(), budgetMs, undefined)
  }

  read(): string {
    return normalizeMachineName(this.readConfiguredName()) || sharedDetectedName || this.hostname
  }
}
