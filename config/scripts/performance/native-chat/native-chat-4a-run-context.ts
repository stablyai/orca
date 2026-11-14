// What every 4a operation family receives, plus the one helper that turns a timed action into a row sample.
import { existsSync, renameSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { copyProfile, launchArm, stopArm, type Arm, type Launch } from './native-chat-4a-arm'
import { ConversionObserver } from './native-chat-4a-sqlite-observer'
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
  relaunch: (prepare?: (userDataDir: string) => void) => Promise<void>
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
  let sample: Omit<Sample, 'work'>
  let work
  try {
    const startedAt = await rendererNow(page(ctx))
    sample = await action(startedAt)
  } finally {
    work = await done()
  }
  return { ...sample, work }
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

// Each seed copy's first launch converts on the candidate; the observer starts before it, reading only.
export function profileRunner(input: {
  arm: Arm
  out: string
  stubCommand: string
  workload: Workload
  rows: Row[]
  log: (line: string) => void
}) {
  return async (
    seedDir: string,
    manifest: Manifest,
    phase: string,
    body: (ctx: RunContext, observer: ConversionObserver) => Promise<void>,
    workload = input.workload
  ): Promise<void> => {
    const { rows, log } = input
    const profileDir = path.join(input.out, 'profile')
    if (existsSync(profileDir)) {
      renameSync(profileDir, path.join(input.out, `stale-profile-${Date.now()}`))
    }
    copyProfile(seedDir, profileDir)
    resetTags()
    const observer = new ConversionObserver(profileDir)
    const open = () => launchArm(input.arm, profileDir, input.stubCommand)
    const ctx = {
      arm: input.arm,
      launch: await open().catch(async (error: unknown) => {
        await observer.stop()
        throw error
      }),
      workload,
      manifest,
      rows,
      log,
      relaunch: async () => undefined
    }
    let running = true
    ctx.relaunch = async (prepare?: (userDataDir: string) => void) => {
      if (running) {
        await stopArm(ctx.launch)
        running = false
      }
      prepare?.(ctx.launch.userDataDir)
      ctx.launch = await open()
      running = true
    }
    try {
      await body(ctx, observer)
    } finally {
      await observer.stop()
      if (running) {
        await stopArm(ctx.launch)
      }
      renameSync(
        profileDir,
        path.join(
          input.out,
          `after-${input.arm.name}-${phase}-${manifest.toolOutputBytes}-${input.arm.sha.slice(0, 8)}`
        )
      )
    }
  }
}
