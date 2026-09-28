import { join } from 'node:path'
import { z } from 'zod'
import { spawnBunPty } from '../daemon/pty-subprocess/bun-pty-process'
import { createWindowsBunPtyLaunch } from '../daemon/pty-subprocess/windows-bun-pty-launch'
import { runBundledBunFixture } from '../bundled-bun-test-execution'

const transcript = z.array(
  z.union([z.object({ data: z.string() }), z.object({ resizeTo: z.number() })])
)
export type PtyTranscriptEvent = z.infer<typeof transcript>[number]
type TranscriptOptions = {
  script: string
  cols: number
  rows: number
  resizes?: { atMs: number; cols: number }[]
}

/** Captures real output and resize ordering for replay into the production emulator. */
export async function recordBunPtyTranscript(
  options: TranscriptOptions
): Promise<PtyTranscriptEvent[]> {
  if (!process.versions.bun) {
    return transcript.parse(
      await runBundledBunFixture(__filename, 'recordBunPtyTranscript', options, 25_000)
    )
  }
  const proc = spawnBunPty(
    {
      file: process.execPath,
      args: ['-e', options.script],
      cols: options.cols,
      rows: options.rows,
      cwd: process.cwd(),
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
    },
    {
      createWindowsLaunch: (args) =>
        createWindowsBunPtyLaunch(args, {
          workerPath: join(__dirname, '../daemon/pty-subprocess/windows-bun-pty-gate-entry.ts')
        })
    }
  )
  const events: PtyTranscriptEvent[] = []
  const output = proc.onData((data) => events.push({ data }))
  let exitSubscription: { dispose(): void } | undefined
  const exited = new Promise<void>((resolve, reject) => {
    exitSubscription = proc.onExit(({ exitCode }) =>
      exitCode === 0 ? resolve() : reject(new Error(`Fixture exited with ${exitCode}`))
    )
  })
  void exited.catch(() => {})
  const timers: ReturnType<typeof setTimeout>[] = []
  try {
    await proc.waitForSpawn?.()
    for (const resize of options.resizes ?? []) {
      timers.push(
        setTimeout(() => {
          events.push({ resizeTo: resize.cols })
          proc.resize(resize.cols, options.rows)
        }, resize.atMs)
      )
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('PTY transcript fixture timed out')), 20_000)
        })
      ])
    } finally {
      clearTimeout(timeout)
    }
    return events
  } finally {
    for (const timer of timers) {
      clearTimeout(timer)
    }
    output.dispose()
    exitSubscription?.dispose()
    proc.destroy()
  }
}
