import { randomUUID } from 'node:crypto'
import { readlink } from 'node:fs/promises'
import { parseLinuxStartTicks, readBootIdentity } from '../agent-hooks/managed-hook-owner-identity'
import type { PreparedLaunchIncarnation } from '../../shared/prepared-agent-launch'
import {
  inspectProcessSignal,
  queryWindowsProcess,
  readLinuxStat,
  readMacosProcessStartedAtMs
} from './daemon-process-inspection'

/** Kernel facts of one live PID, each present only when it was actually read. */
type ProcessFacts = { start?: string; namespace?: string }

export async function readCurrentPreparedLaunchIncarnation(): Promise<PreparedLaunchIncarnation> {
  const [facts, boot] = await Promise.all([
    readProcessFacts(process.pid).catch(() => undefined),
    readBootIdentity().catch(() => undefined)
  ])
  return {
    pid: process.pid,
    ...(facts?.namespace ? { namespace: facts.namespace } : {}),
    ...(facts?.start ? { start: facts.start } : {}),
    ...(boot ? { boot } : {})
  }
}

/** The generation names its daemon process incarnation, so a saved descriptor can prove that owner gone. */
export function formatPreparedLaunchGeneration(incarnation: PreparedLaunchIncarnation): string {
  return `${randomUUID()}.${Buffer.from(JSON.stringify(incarnation)).toString('base64url')}`
}

export function parsePreparedLaunchGeneration(
  generation: string
): PreparedLaunchIncarnation | null {
  const encoded = generation.split('.')[1]
  if (!encoded) {
    return null
  }
  try {
    return parsePreparedLaunchIncarnation(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    )
  } catch {
    return null
  }
}

/** Unknown fields, such as an older opaque process digest, are dropped rather than compared. */
export function parsePreparedLaunchIncarnation(value: unknown): PreparedLaunchIncarnation | null {
  if (typeof value !== 'object' || value === null || !('pid' in value)) {
    return null
  }
  const { pid } = value
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return null
  }
  const incarnation: PreparedLaunchIncarnation = { pid }
  const facts = {
    namespace: 'namespace' in value ? value.namespace : undefined,
    start: 'start' in value ? value.start : undefined,
    boot: 'boot' in value ? value.boot : undefined
  }
  for (const key of ['namespace', 'start', 'boot'] as const) {
    const fact = facts[key]
    if (typeof fact === 'string' && fact) {
      incarnation[key] = fact
    }
  }
  return incarnation
}

/**
 * Positive demise only: a known different boot, a vanished PID, or a known different start in the
 * same PID namespace. A fact either side could not read proves nothing, so a better later
 * observation of the same process never reads as another process.
 */
export async function isPreparedLaunchIncarnationGone(
  incarnation: PreparedLaunchIncarnation,
  currentBoot: () => Promise<string | undefined> = readCurrentBoot
): Promise<boolean> {
  if (incarnation.boot) {
    const boot = await currentBoot()
    if (boot && boot !== incarnation.boot) {
      return true
    }
  }
  const current = await readProcessFacts(incarnation.pid).catch(() => undefined)
  if (current === null) {
    return true
  }
  const sameScope =
    process.platform !== 'linux' ||
    (incarnation.namespace !== undefined && incarnation.namespace === current?.namespace)
  return (
    sameScope &&
    incarnation.start !== undefined &&
    current?.start !== undefined &&
    current.start !== incarnation.start
  )
}

/** null means the PID is confirmed absent; undefined means it could not be read at all. */
async function readProcessFacts(pid: number): Promise<ProcessFacts | null | undefined> {
  if (process.platform === 'win32') {
    const row = await queryWindowsProcess(pid)
    if (row.status !== 'present') {
      return row.status === 'missing' ? null : undefined
    }
    return row.startedAtMs ? { start: String(row.startedAtMs) } : {}
  }
  if (process.platform === 'linux') {
    const stat = await readLinuxStat(pid)
    if (stat.status !== 'present') {
      return stat.status === 'missing' ? null : undefined
    }
    const start = parseLinuxStartTicks(stat.value)
    const namespace = await readlink(`/proc/${pid}/ns/pid`).catch(() => '')
    return { ...(start ? { start } : {}), ...(namespace ? { namespace } : {}) }
  }
  const startedAt = await readMacosProcessStartedAtMs(pid)
  if (startedAt !== null) {
    return { start: String(startedAt) }
  }
  const signal = inspectProcessSignal(pid)
  return signal === 'missing' ? null : signal === 'unavailable' ? undefined : {}
}

function readCurrentBoot(): Promise<string | undefined> {
  return readBootIdentity().catch(() => undefined)
}
