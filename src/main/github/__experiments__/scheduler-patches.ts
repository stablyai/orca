/**
 * DISPOSABLE EXPERIMENT (STA-8667 D3). Builds variants of the REAL renderer refresh scheduler
 * by patching its source text, so a probe always runs production code plus a named, small diff.
 *
 *   base  the scheduler as it is at the checked-out commit
 *   d2    the D2 proposal: host hint consulted BEFORE the "no timed interval" guard (D2-1 defect)
 *   d3    the D3 proposal:
 *           1. no-timer precedence: the hint is consulted only after `intervalMs === null`
 *           2. a completion for an identity that is no longer current neither clears the newer
 *              identity's pending discovery nor charges it a failure (R-C4-1)
 *           3. foreground: a selected target older than 60 s is read on window return, timed
 *              or not and whatever its hint says; a stopped non-selected target only when older
 *              than 15 min; `foreground()` gives focus-only returns the same treatment (R-C4-3)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { createVisibleHostedReviewRefreshScheduler } from '../../../renderer/src/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler'

type Base = ReturnType<typeof createVisibleHostedReviewRefreshScheduler>
export type PatchedScheduler = Base & { foreground?: () => void }
export type SchedulerFactory = () => PatchedScheduler
export type SchedulerVariant = 'base' | 'd2' | 'd3'

const SRC = path.resolve(
  __dirname,
  '../../../renderer/src/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler.ts'
)

function replaceOnce(text: string, find: string, replacement: string, label: string): string {
  if (text.split(find).length !== 2) throw new Error(`scheduler patch anchor moved or not unique: ${label}`)
  return text.replace(find, replacement)
}

export function patchedSchedulerSource(variant: SchedulerVariant): string {
  let text = readFileSync(SRC, 'utf8')
  text = replaceOnce(
    text,
    "'../../../../../../shared/review-refresh-policy'",
    "'../../../../shared/review-refresh-policy'",
    'import'
  )
  if (variant === 'base') return text
  text = replaceOnce(text, '  selected: boolean\n  refresh:', '  selected: boolean\n  nextRefreshAt?: number | null\n  refresh:', 'target type')
  const hint =
    '    if (entry.target.nextRefreshAt != null && entry.target.nextRefreshAt > entry.lastAttemptAt) {\n      return Math.max(cooldown, entry.target.nextRefreshAt)\n    }\n'
  const nullGuard = '    if (entry.target.intervalMs === null) {\n      return Infinity\n    }\n'
  const anchor = '    const anchor = Math.max(entry.target.fetchedAt ?? -Infinity, entry.lastAttemptAt)\n'
  if (variant === 'd2') {
    return replaceOnce(text, nullGuard + anchor, hint + nullGuard + anchor, 'd2 hint')
  }
  // 1. No-timer precedence.
  text = replaceOnce(text, nullGuard + anchor, nullGuard + hint + anchor, 'd3 hint')
  // 2. Stale completion keeps the newer identity's discovery.
  text = replaceOnce(
    text,
    '      } else if (!succeeded || !discoveryIdentityChanged(target, entry.target)) {',
    '      } else if (discoveryIdentityChanged(target, entry.target)) {\n        entry.discovery = true\n      } else {',
    'd3 stale completion'
  )
  // 3. Foreground freshness.
  text = replaceOnce(
    text,
    '          if (\n            entry.target.intervalMs === null &&\n            Date.now() - (entry.target.fetchedAt ?? -Infinity) >= 60_000\n          ) {\n            entry.discovery = true\n          }',
    '          markForeground(entry)',
    'd3 setVisible'
  )
  text = replaceOnce(
    text,
    '  function reconcile(): void {',
    '  const markForeground = (entry: Entry): void => {\n' +
      '    const age = Date.now() - (entry.target.fetchedAt ?? -Infinity)\n' +
      '    // Foreground freshness: selected 60 s (the selected base interval), stopped others 15 min.\n    if (entry.target.selected ? age >= 60_000 : entry.target.intervalMs === null && age >= 15 * 60_000) {\n' +
      '      entry.discovery = true\n' +
      '    }\n' +
      '  }\n\n' +
      '  function reconcile(): void {',
    'd3 markForeground'
  )
  text = replaceOnce(
    text,
    '    dispose(): void {',
    '    foreground(): void {\n      if (disposed || !visible) {\n        return\n      }\n      for (const entry of entries.values()) {\n        markForeground(entry)\n      }\n      reconcile()\n    },\n    dispose(): void {',
    'd3 foreground()'
  )
  return text
}

export async function schedulerFactory(variant: SchedulerVariant): Promise<SchedulerFactory> {
  const out = path.resolve(__dirname, `.generated/scheduler-${variant}.ts`)
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, patchedSchedulerSource(variant))
  return (await import(/* @vite-ignore */ out)).createVisibleHostedReviewRefreshScheduler
}

/**
 * Client-side store for host hints (D2-1). A hint is only usable while nothing that could make
 * it obsolete has happened since the request that produced it STARTED:
 *   - epoch: bumped for one key on identity/selection change, for all keys on pause enter/leave
 *     and on reconnect; a reply to a request started in an older epoch cannot install a hint
 *   - basis: the cache `fetchedAt` the hint was issued against; newer data from any other path
 *     (push, foreground, mutation) retires the hint
 * `null` from the host means "no timed read" and is stored as such.
 */
export function createHintStore() {
  let global = 0
  const perKey = new Map<string, number>()
  const hints = new Map<string, { at: number | null; epoch: string; basis: number | null }>()
  const epoch = (key: string): string => `${global}:${perKey.get(key) ?? 0}`
  return {
    epoch,
    note(key: string, at: number | null, startedInEpoch: string, basisFetchedAt: number | null): boolean {
      if (startedInEpoch !== epoch(key)) return false
      hints.set(key, { at, epoch: startedInEpoch, basis: basisFetchedAt })
      return true
    },
    /** undefined = no usable hint (fall back to the local interval); null = host says no timer. */
    get(key: string, currentFetchedAt: number | null): number | null | undefined {
      const h = hints.get(key)
      if (!h || h.epoch !== epoch(key) || h.basis !== currentFetchedAt) return undefined
      return h.at
    },
    invalidate(key: string): void {
      perKey.set(key, (perKey.get(key) ?? 0) + 1)
      hints.delete(key)
    },
    invalidateAll(): void {
      global += 1
      hints.clear()
    }
  }
}
