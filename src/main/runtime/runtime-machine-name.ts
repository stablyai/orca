import os from 'node:os'
import { runProcess } from '../../shared/child-process/run-process'
import { normalizeMachineName } from '../../shared/machine-name'
import { withTimeout } from '../../shared/promise-timeout-fallback'

const MACOS_COMPUTER_NAME = '/usr/sbin/scutil'
// Why: scutil answers in milliseconds when idle but can take seconds while the Mac boots the app
// under load; a slow right answer beats a fast wrong one, and publishers cap their own wait below.
const MACOS_COMPUTER_NAME_TIMEOUT_MS = 5_000
const MACOS_COMPUTER_NAME_MAX_OUTPUT_BYTES = 4 * 1024
// Why: `orca status` probes status publishers with a 1 s budget; past this a publisher answers with
// the hostname while the lookup keeps running, and the next status read carries the friendly name.
export const MACHINE_NAME_PUBLISH_WAIT_MS = 750
// Why: a failed lookup is retried, but every status read reaches for it, so bound the spawn rate.
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
    // Why: no friendly-name source off macOS, so the hostname is the correct final answer.
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

// Why: the friendly name is a property of the process's host, so every runtime in a process
// (the app, plus each one a test builds) shares one lookup instead of spawning scutil apiece.
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

// Why: a timeout under load is not a fact about the host; dropping the memo lets a later
// `ready()` re-derive the name instead of latching the hostname for the rest of the process.
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
