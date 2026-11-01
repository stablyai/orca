import {
  clampUsedPercent,
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../src/shared/usage-percentage-display'

export type ComposerUsageMeterReadout = {
  /** Rounded consumption. Band color follows this so a nearly empty remainder stays red. */
  used: number
  /** Fill width and the number in the label. Remaining mode is the complement of `used`. */
  shown: number
}

export function composerUsageMeterReadout(
  usedPercent: number,
  display: UsagePercentageDisplay
): ComposerUsageMeterReadout {
  return {
    used: clampUsedPercent(usedPercent),
    shown: getDisplayedUsagePercentage(usedPercent, display)
  }
}
