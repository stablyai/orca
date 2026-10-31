/** Limit ps to the pane's terminal so launch paste avoids whole-machine scans that take seconds on loaded hosts. */

import { runProcess } from '@orca/process-host'
import { runPsInProcess } from '../../shared/libproc-process-table'
import { parseShellForegroundRows, type ProcessTableRow } from '../../shared/process-table-snapshot'
import { psLocaleEnvironment } from '../../shared/ps-locale-environment'

const PS_TIMEOUT_MS = 3_000
const PS_MAX_OUTPUT_BYTES = 256 * 1024
export async function readTerminalPs(
  args: readonly string[],
  timeoutMs = PS_TIMEOUT_MS
): Promise<string | null> {
  try {
    const env = psLocaleEnvironment()
    const result =
      (await runPsInProcess(args, {
        env,
        freshArgv: true,
        timeoutMs,
        maxOutputBytes: PS_MAX_OUTPUT_BYTES
      })) ??
      (await runProcess({
        program: 'ps',
        args,
        env,
        timeoutMs,
        maxOutputBytes: PS_MAX_OUTPUT_BYTES
      }))
    return result.code === 0 && !result.timedOut && !result.outputTruncated && !result.signal
      ? result.stdout
      : null
  } catch {
    return null
  }
}

export function normalizePtyTty(tty: string): string | null {
  const value = tty.trim().replace(/^\/dev\//, '')
  return /^[a-zA-Z0-9_/-]+$/.test(value) && !['-', 'console'].includes(value) ? value : null
}

// Keyed by snapshot array identity, so every new capture regroups even when a TTY name is reused.
const snapshotRowsByTty = new WeakMap<
  readonly ProcessTableRow[],
  ReadonlyMap<string, readonly ProcessTableRow[]>
>()

/** Group a shared snapshot by normalized TTY once per capture, so each pane's display read is a lookup rather than
 * a pass over every unrelated row. Rows keep capture order; rows without a valid TTY belong to no pane. */
export function getSnapshotRowsOnTty(
  rows: readonly ProcessTableRow[],
  tty: string
): readonly ProcessTableRow[] {
  let byTty = snapshotRowsByTty.get(rows)
  if (!byTty) {
    const grouped = new Map<string, ProcessTableRow[]>()
    for (const row of rows) {
      const key = normalizePtyTty(row.tty ?? '')
      if (key) {
        const bucket = grouped.get(key)
        if (bucket) {
          bucket.push(row)
        } else {
          grouped.set(key, [row])
        }
      }
    }
    snapshotRowsByTty.set(rows, grouped)
    byTty = grouped
  }
  return byTty.get(tty) ?? []
}

export async function readTerminalTty(
  rootPid: number,
  timeoutMs = PS_TIMEOUT_MS
): Promise<string | null> {
  const output = await readTerminalPs(['-o', 'tty=', '-p', String(rootPid)], timeoutMs)
  return output === null ? null : normalizePtyTty(output)
}

export async function readPtyTerminalRows(
  tty: string,
  timeoutMs = PS_TIMEOUT_MS
): Promise<ProcessTableRow[] | null> {
  const normalized = normalizePtyTty(tty)
  if (!normalized || timeoutMs <= 0) {
    return null
  }
  const stdout = await readTerminalPs(
    ['-ww', '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,command=', '-t', normalized],
    timeoutMs
  )
  try {
    return stdout === null ? null : parseShellForegroundRows(stdout, { strict: true })
  } catch {
    return null
  }
}

/** Old owners expose only a root PID; rediscover its current terminal on every read. */
export async function readTerminalProcessRows(rootPid: number): Promise<ProcessTableRow[] | null> {
  const deadline = Date.now() + PS_TIMEOUT_MS
  const tty = await readTerminalTty(rootPid, deadline - Date.now())
  const rows = tty ? await readPtyTerminalRows(tty, deadline - Date.now()) : null
  if (!rows?.some((row) => row.pid === rootPid) || Date.now() >= deadline) {
    return null
  }
  return (await readTerminalTty(rootPid, deadline - Date.now())) === tty ? rows : null
}
