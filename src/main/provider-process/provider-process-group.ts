import { discoverProviderLaunches, providerLedgerStates } from './provider-process-inventory'
import { ProviderCleanupBudget } from './provider-process-exit-deadline'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import { setTimeout as delay } from 'node:timers/promises'
import { captureDescendantSnapshot, hasUnambiguousStartTime } from '../pty-descendant-termination'
import { readPosixProcessRow, type ProviderProcessRow } from './provider-process-row-read'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import {
  PROVIDER_GROUP_REAP_TIMEOUT_MS,
  PROVIDER_SIGTERM_GRACE_MS
} from './provider-process-timing'

export type ProviderGroupMember = Pick<ProviderProcessRow, 'pid' | 'startedAt' | 'pgid'>

/** Only a live, directly parented root can add identities to an owned group. */
export async function captureProviderGroup(
  pgid: number,
  retryBirthSecond = true,
  budget?: ProviderCleanupBudget
): Promise<ProviderGroupMember[]> {
  const boundary = Date.now()
  if (budget && !budget.active) {
    return []
  }
  const root = await readPosixProcessRow(pgid, process.platform, budget)
  if (
    !root ||
    root === 'unverifiable' ||
    root.zombie ||
    root.ppid !== process.pid ||
    root.pgid !== pgid
  ) {
    return []
  }
  if (root.startResolution === 'second' && !hasUnambiguousStartTime(root.startedAt, boundary)) {
    if (!retryBirthSecond) {
      return []
    }
    await delay(1_050 - (Date.now() % 1_000))
    return captureProviderGroup(pgid, false, budget)
  }
  const snapshot = await captureDescendantSnapshot(pgid, {
    timeoutMs: Math.min(2_000, budget?.remaining() ?? Infinity)
  })
  const rows =
    snapshot?.rootPgid === pgid ? snapshot.descendants.filter((row) => row.pgid === pgid) : []
  const members = [root, ...rows]
  const qualified: ProviderGroupMember[] = []
  for (const member of members) {
    if (budget && !budget.active) {
      break
    }
    const fresh = await readPosixProcessRow(member.pid, process.platform, budget)
    if (!fresh || fresh === 'unverifiable' || fresh.zombie || fresh.pgid !== member.pgid) {
      continue
    }
    // ps snapshots and /proc ticks have different formats; compare each using its own reader.
    if (member.pid === pgid && fresh.startedAt !== root.startedAt) {
      continue
    }
    if (member.pid !== pgid) {
      if (!snapshot || !hasUnambiguousStartTime(member.startedAt, snapshot.capturedAtMs)) {
        continue
      }
      const started = await readProcessStartTimeMs(member.pid)
      if (
        started === null ||
        Math.floor(started / 1_000) * 1_000 !== Date.parse(member.startedAt)
      ) {
        continue
      }
    }
    if (fresh.startResolution === 'second' && !hasUnambiguousStartTime(fresh.startedAt, boundary)) {
      continue
    }
    const stillRoot = await readPosixProcessRow(pgid, process.platform, budget)
    if (
      !stillRoot ||
      stillRoot === 'unverifiable' ||
      stillRoot.zombie ||
      stillRoot.startedAt !== root.startedAt ||
      stillRoot.ppid !== process.pid
    ) {
      break
    }
    qualified.push(fresh)
  }
  return qualified
}

export function providerGroupVerdict(pgid: number): DescendantTreeVerdict {
  try {
    process.kill(-pgid, 0)
    return 'live'
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
      ? 'exited'
      : 'unverifiable'
  }
}

export async function matchProviderGroupMember(
  members: readonly ProviderGroupMember[],
  pgid: number,
  budget?: ProviderCleanupBudget
): Promise<boolean> {
  for (const member of members) {
    if (budget && !budget.active) {
      return false
    }
    const row = await readPosixProcessRow(member.pid, process.platform, budget)
    if (
      member.pgid === pgid &&
      row &&
      row !== 'unverifiable' &&
      !row.zombie &&
      row.startedAt === member.startedAt &&
      row.pgid === pgid
    ) {
      return true
    }
  }
  return false
}

/** A signal is delivery, never evidence of disappearance. */
export function signalProviderGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    /* A fresh probe supplies the verdict. */
  }
}

export async function observeProviderGroup(
  pgid: number,
  timeoutMs: number,
  budget?: ProviderCleanupBudget
): Promise<DescendantTreeVerdict> {
  const deadline = Math.min(Date.now() + timeoutMs, budget?.deadline ?? Infinity)
  let verdict = providerGroupVerdict(pgid)
  while ((!budget || budget.active) && verdict !== 'exited' && Date.now() < deadline) {
    await delay(Math.min(50, deadline - Date.now()))
    verdict = providerGroupVerdict(pgid)
  }
  return verdict
}

/** Revalidate a recorded member before every delayed escalation; never revive an empty group. */
export async function stopRecordedProviderGroup(
  pgid: number,
  members: readonly ProviderGroupMember[],
  owns: () => Promise<boolean> = async () => true,
  termSent = false,
  budget?: ProviderCleanupBudget
): Promise<DescendantTreeVerdict> {
  if (budget && !budget.active) {
    return 'unverifiable'
  }
  if (providerGroupVerdict(pgid) === 'exited') {
    return 'exited'
  }
  if (!termSent) {
    if (
      !(await owns()) ||
      !(await matchProviderGroupMember(members, pgid, budget)) ||
      (budget && !budget.active)
    ) {
      return 'unverifiable'
    }
    signalProviderGroup(pgid, 'SIGTERM')
  }
  const verdict = await observeProviderGroup(pgid, PROVIDER_SIGTERM_GRACE_MS, budget)
  if (verdict === 'exited') {
    return verdict
  }
  if (
    !(await owns()) ||
    !(await matchProviderGroupMember(members, pgid, budget)) ||
    (budget && !budget.active)
  ) {
    return 'unverifiable'
  }
  signalProviderGroup(pgid, 'SIGKILL')
  return observeProviderGroup(pgid, PROVIDER_GROUP_REAP_TIMEOUT_MS, budget)
}

/** A retained old root number is not proof that a new lease came from direct launch. */
export async function hasRecordedProviderLaunch(
  pgid: number,
  processStartTimeMs?: number
): Promise<boolean> {
  const budget = new ProviderCleanupBudget(Date.now() + 2_000)
  if (!(await discoverProviderLaunches(budget))) {
    return false
  }
  const row = await readPosixProcessRow(pgid, process.platform, budget)
  if (
    !row ||
    row === 'unverifiable' ||
    row.zombie ||
    processStartTimeMs === undefined ||
    (await readProcessStartTimeMs(pgid)) !== processStartTimeMs
  ) {
    return false
  }
  return (
    budget.active &&
    providerLedgerStates().some(
      ({ entry }) =>
        entry.pgid === pgid &&
        entry.members.some((member) => member.pid === pgid && member.startedAt === row.startedAt)
    )
  )
}
