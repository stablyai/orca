import { createHash, randomUUID } from 'node:crypto'
import {
  readBootIdentity,
  readManagedHookProcessIdentity
} from '../agent-hooks/managed-hook-owner-identity'
import type { PreparedLaunchIncarnation } from '../../shared/prepared-agent-launch'
import { inspectProcessSignal } from './daemon-process-inspection'

export async function readCurrentPreparedLaunchIncarnation(): Promise<PreparedLaunchIncarnation> {
  const [processIdentity, boot] = await Promise.all([
    readManagedHookProcessIdentity(process.pid).catch(() => undefined),
    readBootIdentity().catch(() => undefined)
  ])
  return {
    pid: process.pid,
    // A process-local fallback token cannot be re-read by another process, so it proves nothing.
    ...(processIdentity && !processIdentity.startsWith('runtime:')
      ? { process: digestProcessIdentity(processIdentity) }
      : {}),
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
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (
      typeof value !== 'object' ||
      value === null ||
      !('pid' in value) ||
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0
    ) {
      return null
    }
    return {
      pid: value.pid,
      ...('process' in value && typeof value.process === 'string'
        ? { process: value.process }
        : {}),
      ...('boot' in value && typeof value.boot === 'string' ? { boot: value.boot } : {})
    }
  } catch {
    return null
  }
}

/** Positive demise only: another boot, or a vanished or reused PID. Unreadable evidence is never demise. */
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
  if (!incarnation.process) {
    // Without a start identity only a vanished PID proves demise; a reused one reads as alive.
    return inspectProcessSignal(incarnation.pid) === 'missing'
  }
  const current = await readManagedHookProcessIdentity(incarnation.pid).catch(() => undefined)
  return (
    current === null ||
    (current !== undefined && digestProcessIdentity(current) !== incarnation.process)
  )
}

function readCurrentBoot(): Promise<string | undefined> {
  return readBootIdentity().catch(() => undefined)
}

// Start identities can carry a whole command line; the generation only needs to compare them.
function digestProcessIdentity(identity: string): string {
  return createHash('sha256').update(identity).digest('base64url').slice(0, 22)
}
