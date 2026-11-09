// What every 4a operation family receives, plus the one helper that turns a timed action into a row sample.
import type { Page } from '@stablyai/playwright-test'
import type { Arm, Launch } from './native-chat-4a-arm'
import type { Manifest } from './native-chat-4a-fixture'
import { hostWorkMark, rendererNow } from './native-chat-4a-probes'
import type { Row, Sample } from './native-chat-4a-report'
import type { Workload } from './native-chat-4a-workloads'

export type RunContext = {
  arm: Arm
  launch: Launch
  workload: Workload
  manifest: Manifest
  rows: Row[]
  log: (line: string) => void
  /** Relaunch on the same profile (cold rows); replaces `launch`. */
  relaunch: () => Promise<void>
}

export const page = (ctx: RunContext): Page => ctx.launch.page

export function addRow(ctx: RunContext, row: Omit<Row, 'samples'> & { samples?: Sample[] }): Row {
  const full: Row = { samples: [], ...row }
  ctx.rows.push(full)
  return full
}

/** Run `action` and record host work around it; `action` returns renderer-clock end points relative to its own start. */
export async function measured(
  ctx: RunContext,
  action: (startedAt: number) => Promise<Omit<Sample, 'work'>>
): Promise<Sample> {
  const done = await hostWorkMark(ctx.launch.app)
  const startedAt = await rendererNow(page(ctx))
  const sample = await action(startedAt)
  return { ...sample, work: await done() }
}

/** Run a row's samples, recording a failure as the row's skip reason instead of losing the whole family. */
export async function sampled(
  ctx: RunContext,
  row: Row,
  count: number,
  take: (index: number) => Promise<Sample>
): Promise<void> {
  try {
    for (let index = 0; index < count; index += 1) {
      row.samples.push(await take(index))
    }
  } catch (error) {
    row.skipped =
      `failed after ${row.samples.length} samples: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        300
      )
    ctx.log(`${row.family}/${row.operation}/${row.variant}: ${row.skipped}`)
  }
}

// Reset per arm so both arms send byte-identical prompts in the same order.
let unique = 0
export const resetTags = (): void => {
  unique = 0
}
export const tagFor = (prefix: string): string =>
  `${prefix}-${String((unique += 1)).padStart(5, '0')}`
