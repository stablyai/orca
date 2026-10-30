import { z } from 'zod'
import type { BrowserScreenshotOptions } from '../../shared/runtime-types'

export const AgentBrowserScreenshotResult = z.object({
  // Absent when --if-changed found no change.
  path: z.string().min(1).optional(),
  changed: z.boolean().optional(),
  annotations: z
    .array(
      z.object({
        ref: z.string(),
        number: z.number(),
        role: z.string(),
        name: z.string().optional(),
        box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
      })
    )
    .optional()
    // A changed legend shape must not cost the agent its screenshot.
    .catch(undefined)
})

export function agentBrowserScreenshotArgs(
  options: BrowserScreenshotOptions,
  fullPage = false
): string[] {
  const args = ['screenshot']
  if (fullPage) {
    args.push('--full')
  }
  if (options.ifChanged) {
    args.push('--if-changed')
  }
  if (options.annotate) {
    args.push('--annotate')
  }
  args.push('--screenshot-format', options.format === 'jpeg' ? 'jpeg' : 'png')
  return args
}
