import { usageBandColor } from '../accounts/usage/UsageBar'
import type { MobilePalette } from '../theme/mobile-theme'
import type { UsagePace } from './usage-window-pace'

/** How a window is burning against an even pace; `over` would hit the limit before it resets. */
export type UsagePaceTone = 'under' | 'on-pace' | 'ahead' | 'over' | 'unpaced'

/** The pace line's reading: ahead turns `over` once the burn would run out before reset. */
export function usagePaceTone(pace: UsagePace): UsagePaceTone {
  switch (pace.kind) {
    case 'unknown':
      return 'unpaced'
    case 'exhausted':
      return 'over'
    case 'on-pace':
      return 'on-pace'
    case 'under':
      return 'under'
    case 'ahead':
      return pace.runOutBeforeResetMs === null ? 'ahead' : 'over'
  }
}

/**
 * The one colour for a usage window, shared by the composer bar and the usage
 * pop-up's pace line: green while on or under pace, amber ahead of it, red when the limit would be
 * reached before reset (or is). Without a pace (no reset time) it falls back to the used-level band.
 */
export function usagePaceColor(
  pace: UsagePace,
  usedPercent: number | null,
  colors: MobilePalette
): string {
  switch (usagePaceTone(pace)) {
    case 'under':
    case 'on-pace':
      return colors.statusGreen
    case 'ahead':
      return colors.statusAmber
    case 'over':
      return colors.statusRed
    case 'unpaced':
      return usageBandColor(usedPercent, colors)
  }
}
