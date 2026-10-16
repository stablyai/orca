import type {
  PtyJobProcessIdentity,
  PtyJobTerminationReport
} from '../windows/windows-pty-job-termination-report'

export const PTY_JOB_NOT_TERMINATED: PtyJobTerminationReport = { terminated: false }

function isIdentity(value: unknown): value is PtyJobProcessIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pid' in value &&
    'startTime' in value &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startTime === 'string' &&
    value.startTime.length > 0
  )
}

/** A reply proves the job ended only when every member is a distinct, well-formed identity. */
export function validatePtyJobTerminationReport(reply: unknown): PtyJobTerminationReport {
  if (
    typeof reply !== 'object' ||
    reply === null ||
    !('terminated' in reply) ||
    reply.terminated !== true ||
    !('identities' in reply) ||
    !Array.isArray(reply.identities)
  ) {
    return PTY_JOB_NOT_TERMINATED
  }
  const identities: PtyJobProcessIdentity[] = []
  for (const entry of reply.identities) {
    if (!isIdentity(entry) || identities.some((seen) => seen.pid === entry.pid)) {
      return PTY_JOB_NOT_TERMINATED
    }
    identities.push({ pid: entry.pid, startTime: entry.startTime })
  }
  return identities.length > 0 ? { terminated: true, identities } : PTY_JOB_NOT_TERMINATED
}
