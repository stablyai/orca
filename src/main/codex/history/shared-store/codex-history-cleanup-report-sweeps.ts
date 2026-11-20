import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { writePluginFileAtomically } from '../../../plugins/installation/plugin-atomic-file-write'

const KEPT_REVISIONS = 4

/** A home whose report-mode sweep finished under one policy revision, in a marker file. */
export type ReportSweep = { markerPath: string; revision: number; accountHome: string }

async function readSwept(markerPath: string): Promise<Map<number, string[]>> {
  const swept = new Map<number, string[]>()
  try {
    const parsed: unknown = JSON.parse(await readFile(markerPath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [revision, homes] of Object.entries(parsed)) {
        if (/^\d+$/.test(revision) && Array.isArray(homes)) {
          swept.set(
            Number(revision),
            homes.filter((home): home is string => typeof home === 'string')
          )
        }
      }
    }
  } catch {
    // Missing or damaged: every home reports again.
  }
  return swept
}

/** Whether this install already reported the home under this revision. */
export async function wasReportSwept(sweep: ReportSweep): Promise<boolean> {
  const homes = (await readSwept(sweep.markerPath)).get(sweep.revision) ?? []
  return homes.includes(normalizeRuntimePathForComparison(sweep.accountHome))
}

/** Remembers a finished report sweep, keeping only the newest revisions. */
export async function recordReportSweep(sweep: ReportSweep): Promise<void> {
  try {
    await mkdir(dirname(sweep.markerPath), { recursive: true })
    // Read right before the write, so another instance's homes survive; one written in between
    // only costs that home one more sweep.
    const swept = await readSwept(sweep.markerPath)
    const home = normalizeRuntimePathForComparison(sweep.accountHome)
    const homes = swept.get(sweep.revision) ?? []
    swept.delete(sweep.revision)
    // The revision in force stays even when older than the rest (0 while no policy is known).
    const kept = new Map(
      [...swept.entries()].sort(([a], [b]) => b - a).slice(0, KEPT_REVISIONS - 1)
    )
    kept.set(sweep.revision, homes.includes(home) ? homes : [...homes, home])
    await writePluginFileAtomically(
      sweep.markerPath,
      `${JSON.stringify(Object.fromEntries(kept))}\n`
    )
  } catch (error) {
    console.warn('[codex-account-history] Cleanup report marker not saved:', error)
  }
}
