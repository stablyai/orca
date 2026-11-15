import type {
  ThemeStudioMode,
  ThemeStudioPatch
} from '../../shared/theme-studio/theme-studio-draft'
import type { ThemeStudioReport } from '../../shared/theme-studio/theme-studio-protocol'

export type ThemeStudioPaint = {
  status: 'painted' | 'other-variant' | 'no-viewer' | 'coalesced' | 'timeout'
  mode?: ThemeStudioMode
  /** What the window actually left unpainted for this revision, from the paint itself. */
  dropped: string[]
  editor?: 'follows-app' | 'pinned'
  windows: number
}

/** The smallest fix of each finding (or only of `ids`), as one patch. */
export function fixPatch(
  report: ThemeStudioReport | null,
  ids?: ReadonlySet<string>
): { patch: ThemeStudioPatch; fixed: string[] } {
  const patch: ThemeStudioPatch = {}
  const fixed: string[] = []
  for (const { mode, findings } of report?.modes ?? []) {
    const set: Record<string, string> = {}
    for (const finding of findings) {
      const fix = finding.fixes[0]
      if (!fix || (ids && !ids.has(finding.id))) {
        continue
      }
      // Why skip a taken token: two findings on one token are both fixed by its first value.
      if (Object.keys(fix.set).some((token) => token in set)) {
        continue
      }
      Object.assign(set, fix.set)
      fixed.push(finding.id)
    }
    if (Object.keys(set).length) {
      patch[mode] = { set }
    }
  }
  return { patch, fixed }
}

/** How the change reached the screen, so the agent knows whether a shot would show it. */
export function paintOutcome(
  report: ThemeStudioReport | null,
  revision: number,
  changedModes: readonly ThemeStudioMode[],
  hasWindow: boolean
): ThemeStudioPaint {
  if (!hasWindow) {
    return { status: 'no-viewer', dropped: [], windows: 0 }
  }
  if (!report?.paint) {
    return { status: 'timeout', dropped: [], windows: 1 }
  }
  const { mode, dropped, editor } = report.paint
  const status =
    report.revision > revision
      ? 'coalesced'
      : changedModes.length > 0 && !changedModes.includes(mode)
        ? 'other-variant'
        : 'painted'
  return { status, mode, dropped, editor, windows: 1 }
}
