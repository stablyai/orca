import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import type { HangStacks } from './hang-stacks'

export function hangCaptureDetails(
  prefix: string,
  capture: HangStacks & object
): CrashReportBreadcrumbData {
  const details: CrashReportBreadcrumbData = {}
  for (const [key, value] of Object.entries(capture)) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      details[`${prefix}_${key}`] = value
    }
  }
  for (const [index, stack] of capture.stacks.entries()) {
    details[`${prefix}${index}_count`] = stack.count
    details[`${prefix}${index}_hot`] = stack.hot
    for (const [frameIndex, frame] of stack.frames.entries()) {
      details[`${prefix}${index}_frame${frameIndex}`] =
        `${frame.name} [${frame.module}${frame.line !== undefined ? `:${frame.line}:${frame.column ?? 0}` : ''}]`
    }
  }
  return details
}
