import type { BrowserScreenshotOptions } from '../../shared/rpc-contract/browser-params'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  BrowserScreenshotAnnotation,
  BrowserScreenshotResult
} from '../../shared/runtime-types'
import { BrowserError } from './browser-error'

const Annotation: z.ZodType<BrowserScreenshotAnnotation> = z.object({
  ref: z.string(),
  number: z.number(),
  role: z.string(),
  name: z.string().optional(),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
})

const AgentBrowserScreenshotResult = z.object({
  // Absent when --if-changed found no change.
  path: z.string().min(1).optional(),
  changed: z.boolean().optional(),
  // A changed legend shape must not cost the agent its screenshot.
  annotations: z.array(Annotation).optional().catch(undefined)
})

export function agentBrowserScreenshotArgs(
  options: BrowserScreenshotOptions,
  capture: { outputDir: string; fullPage?: boolean }
): string[] {
  const format = options.format ?? 'png'
  // agent-browser's default name is per millisecond, so two pages could share (and delete) one file.
  const outputPath = join(
    capture.outputDir,
    `orca-screenshot-${randomUUID()}.${format === 'jpeg' ? 'jpg' : 'png'}`
  )
  const args = ['screenshot', outputPath]
  if (capture.fullPage) {
    args.push('--full')
  }
  if (options.ifChanged) {
    args.push('--if-changed')
  }
  if (options.annotate) {
    args.push('--annotate')
  }
  args.push('--screenshot-format', format)
  return args
}

/** Reads and removes the capture agent-browser wrote; `encode` turns its bytes into the base64 returned. */
export async function readAgentBrowserScreenshot(
  raw: unknown,
  format: 'png' | 'jpeg',
  encode: (bytes: Buffer) => Promise<string> | string
): Promise<BrowserScreenshotResult> {
  const parsed = AgentBrowserScreenshotResult.safeParse(raw)
  const { path, changed, annotations } = parsed.success ? parsed.data : {}
  if (!path) {
    if (changed === false) {
      return { data: '', format, changed, annotations }
    }
    throw new BrowserError('browser_error', 'Screenshot returned no file path')
  }
  try {
    const bytes = await readFile(path).catch(() => {
      throw new BrowserError('browser_error', `Screenshot file not found: ${path}`)
    })
    return { data: await encode(bytes), format, changed, annotations }
  } finally {
    await rm(path, { force: true }).catch(() => {})
  }
}
