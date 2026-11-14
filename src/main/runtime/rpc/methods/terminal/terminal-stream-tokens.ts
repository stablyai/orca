import { randomUUID } from 'node:crypto'
import { TerminalStreamResumeLedger, type TerminalResumeGap } from './terminal-stream-resume-ledger'
import type { TerminalSubscriptionArgs } from './terminal-subscribe-types'

// A tab switch or a reconnect comes back within seconds; two minutes covers a phone left in a pocket.
const RESUME_RETAIN_MS = 2 * 60_000
const MAX_RETAINED_STREAMS_PER_DEVICE = 8
type TerminalStreamTokenEntry = {
  deviceId: string | undefined
  acknowledgeOutput: (units: number) => void
  resume: { ledger: TerminalStreamResumeLedger; releaseRing: () => void } | null
  // Presented while live: an old shell replaying stale params must never resume it later.
  spent: boolean
  expiry?: ReturnType<typeof setTimeout>
}

// Why tokens: relays renumber streamId, and a late ack keyed by terminal+client would credit its successor.
const liveStreams = new Map<string, TerminalStreamTokenEntry>()
// Ended streams a client may resume once, in retention order.
const retainedStreams = new Map<string, TerminalStreamTokenEntry>()

export type TerminalStreamToken = {
  token: string
  ledger: TerminalStreamResumeLedger | null
  release: () => void
}

export function registerTerminalStreamToken(
  stream: Pick<TerminalSubscriptionArgs, 'runtime' | 'ptyId' | 'isMobile' | 'pairedDeviceId'>,
  acknowledgeOutput: (units: number) => void
): TerminalStreamToken {
  const token = randomUUID()
  // Phone streams keep the PTY's published output so a later subscribe can resume from them.
  const ring = stream.isMobile ? stream.runtime.retainPublishedTerminalOutput(stream.ptyId) : null
  const resume = ring && {
    ledger: new TerminalStreamResumeLedger(stream.ptyId, ring.ring),
    releaseRing: ring.release
  }
  const entry: TerminalStreamTokenEntry = {
    deviceId: stream.pairedDeviceId,
    acknowledgeOutput,
    resume,
    spent: false
  }
  liveStreams.set(token, entry)
  return {
    token,
    ledger: resume?.ledger ?? null,
    release: () => {
      if (liveStreams.get(token) !== entry) {
        return
      }
      liveStreams.delete(token)
      if (entry.resume && !entry.spent) {
        retainForResume(token, entry)
      } else {
        entry.resume?.releaseRing()
      }
    }
  }
}

function retainForResume(token: string, entry: TerminalStreamTokenEntry): void {
  const sameDevice = [...retainedStreams].filter(
    ([, retained]) => retained.deviceId === entry.deviceId
  )
  while (sameDevice.length >= MAX_RETAINED_STREAMS_PER_DEVICE) {
    discardRetained(sameDevice.shift()![0])
  }
  // Ended streams take no acks; don't keep the subscription's scope alive through this closure.
  entry.acknowledgeOutput = () => {}
  entry.expiry = setTimeout(() => discardRetained(token), RESUME_RETAIN_MS)
  entry.expiry.unref?.()
  retainedStreams.set(token, entry)
}

function discardRetained(token: string): void {
  const entry = retainedStreams.get(token)
  if (!entry) {
    return
  }
  retainedStreams.delete(token)
  clearTimeout(entry.expiry)
  entry.resume?.releaseRing()
}

/** Spends `token` (single use) and returns the gap after `units` on its ended stream, or null for a snapshot instead. */
export function claimTerminalStreamResume(
  token: string,
  deviceId: string | undefined,
  ptyId: string,
  units: number,
  currentSeq: number
): TerminalResumeGap | null {
  const live = liveStreams.get(token)
  if (live && live.deviceId === deviceId) {
    live.spent = true
    return null
  }
  const entry = retainedStreams.get(token)
  if (!entry?.resume || entry.deviceId !== deviceId) {
    return null
  }
  try {
    return entry.resume.ledger.ptyId === ptyId
      ? entry.resume.ledger.readGap(units, currentSeq)
      : null
  } finally {
    discardRetained(token)
  }
}

export function acknowledgeTerminalStreamOutput(
  token: string,
  deviceId: string | undefined,
  units: number
): boolean {
  const entry = liveStreams.get(token)
  if (!entry || entry.deviceId !== deviceId) {
    return false
  }
  entry.acknowledgeOutput(units)
  return true
}
