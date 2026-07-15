import { PTY_SESSION_COMMAND_TIMEOUT_MS } from '../shared/terminal-teardown-timeouts'

export type PtySessionCommandRunner = (
  file: string,
  args: string[],
  options: { timeout: number }
) => Promise<unknown>

const VERIFY_PID_BATCH_SIZE = 64

export async function rootStillOwnsPty(
  pid: number,
  ptsName: unknown,
  platform: NodeJS.Platform,
  run: PtySessionCommandRunner
): Promise<boolean> {
  const expectedTty = normalizePtyName(ptsName)
  if (!expectedTty) {
    // Why: without the exact controlling TTY, a recycled session-leader PID
    // is not enough authority to signal an unrelated user's process tree.
    return false
  }
  const ownerColumn = platform === 'darwin' ? 'pgid=' : 'sid='
  const result = (await run('ps', ['-p', String(pid), '-o', ownerColumn, '-o', 'tty='], {
    timeout: PTY_SESSION_COMMAND_TIMEOUT_MS
  })) as { stdout?: string | Buffer }
  const columns = String(result.stdout ?? '')
    .trim()
    .split(/\s+/)
  const [ownerText, tty] = columns
  if (columns.length !== 2 || parseCanonicalProcessId(ownerText) !== pid) {
    return false
  }
  return tty === expectedTty
}

export async function listPtyMembers(
  rootPid: number,
  ptsName: unknown,
  platform: NodeJS.Platform,
  run: PtySessionCommandRunner,
  timeout: number
): Promise<number[]> {
  const expectedTty = normalizePtyName(ptsName)
  if (!expectedTty) {
    throw new Error('Exact PTY name unavailable')
  }
  const file = platform === 'linux' ? 'pgrep' : 'ps'
  const args = platform === 'linux' ? ['-s', String(rootPid)] : ['-t', expectedTty, '-o', 'pid=']
  try {
    const result = (await run(file, args, { timeout })) as { stdout?: string | Buffer }
    return parseCanonicalProcessIds(result.stdout)
  } catch (error) {
    if (isEmptyProcessSelection(error)) {
      return []
    }
    throw error
  }
}

export async function frozenMembersStillOwnPty(
  memberPids: readonly number[],
  rootPid: number,
  ptsName: unknown,
  platform: NodeJS.Platform,
  run: PtySessionCommandRunner,
  timeout: number
): Promise<boolean> {
  const expectedTty = normalizePtyName(ptsName)
  if (!expectedTty) {
    return false
  }
  const verified = new Set<number>()
  const verificationDeadline = Date.now() + timeout
  for (let index = 0; index < memberPids.length; index += VERIFY_PID_BATCH_SIZE) {
    const remainingMs = verificationDeadline - Date.now()
    if (remainingMs <= 0) {
      return false
    }
    const batch = memberPids.slice(index, index + VERIFY_PID_BATCH_SIZE)
    const ownerColumn = platform === 'linux' ? ['-o', 'sid='] : []
    const result = (await run(
      'ps',
      ['-p', batch.join(','), '-o', 'pid=', ...ownerColumn, '-o', 'tty='],
      { timeout: remainingMs }
    )) as { stdout?: string | Buffer }
    for (const line of String(result.stdout ?? '')
      .trim()
      .split('\n')) {
      const columns = line.trim().split(/\s+/)
      const [pidText, ownerOrTty, linuxTty] = columns
      const pid = parseCanonicalProcessId(pidText)
      const tty = platform === 'linux' ? linuxTty : ownerOrTty
      if (
        columns.length !== (platform === 'linux' ? 3 : 2) ||
        pid === null ||
        !batch.includes(pid) ||
        verified.has(pid) ||
        tty !== expectedTty ||
        (platform === 'linux' && parseCanonicalProcessId(ownerOrTty) !== rootPid)
      ) {
        return false
      }
      verified.add(pid)
    }
  }
  return verified.size === memberPids.length
}

export function isEmptyProcessSelection(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const processError = error as { code?: unknown; stdout?: unknown }
  // Why: BSD/procps ps/pgrep exit 1 for an empty selector. Only that exact
  // empty result proves absence; ENOENT, timeout, and malformed output fail closed.
  return processError.code === 1 && String(processError.stdout ?? '').trim() === ''
}

export function parseCanonicalProcessIds(stdout: string | Buffer | undefined): number[] {
  const ids: number[] = []
  const seen = new Set<number>()
  for (const token of String(stdout ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)) {
    const pid = parseCanonicalProcessId(token)
    if (pid === null || seen.has(pid)) {
      throw new Error('Malformed PTY process inventory')
    }
    seen.add(pid)
    ids.push(pid)
  }
  return ids
}

export function parseCanonicalProcessId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return null
  }
  const pid = Number(value)
  return Number.isSafeInteger(pid) ? pid : null
}

function normalizePtyName(ptsName: unknown): string | null {
  if (typeof ptsName !== 'string') {
    return null
  }
  const expectedTty = ptsName.startsWith('/dev/') ? ptsName.slice('/dev/'.length) : ptsName
  return /^[A-Za-z0-9._/-]+$/.test(expectedTty) ? expectedTty : null
}
