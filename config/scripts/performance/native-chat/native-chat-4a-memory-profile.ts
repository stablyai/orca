import { existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { seedDirFor, seededChats, type Manifest } from './native-chat-4a-fixture'
import { memoryRows, memoryWorkload } from './native-chat-4a-ops-memory'
import type { ConversionObserver } from './native-chat-4a-sqlite-observer'
import type { Workload } from './native-chat-4a-workloads'
import type { RunContext } from './native-chat-4a-run-context'

export async function seedMemoryProfile(
  out: string,
  workload: Workload,
  seed: (workload: Workload, runDir: string) => Promise<Manifest>,
  log: (line: string) => void
): Promise<{
  memoryProfile?: { seedDir: string; manifest: Manifest }
  memorySeedFailure?: string
}> {
  const runDir = path.join(out, 'memory')
  mkdirSync(runDir, { recursive: true })
  try {
    const manifest = await seed(memoryWorkload(workload), runDir)
    return { memoryProfile: { seedDir: seedDirFor(runDir, manifest), manifest } }
  } catch (error) {
    const memorySeedFailure = `memory seed failed: ${String(error).slice(0, 250)}`
    log(memorySeedFailure)
    const profile = path.join(out, 'profile')
    if (existsSync(profile)) {
      renameSync(profile, path.join(out, `failed-memory-seed-${Date.now()}`))
    }
    return { memorySeedFailure }
  }
}

export async function convertedMemoryRows(
  ctx: RunContext,
  observer: ConversionObserver
): Promise<void> {
  // Conversion completes before the baseline on this otherwise untouched copy.
  if (
    observer.databaseFile &&
    !(await observer.allReady(seededChats(ctx.manifest), 2 * 60 * 60_000))
  ) {
    throw new Error('memory profile conversion did not finish within 2h')
  }
  await observer.stop()
  await memoryRows(ctx)
}
