// Runs each arm's families on copies of the campaign's single pinned seed.
import type { Arm } from './native-chat-4a-arm'
import type { Manifest } from './native-chat-4a-fixture'
import { profileRunner } from './native-chat-4a-run-context'
import * as memory from './native-chat-4a-ops-memory'
import { convertedMemoryRows } from './native-chat-4a-memory-profile'
import type { ArmResult, Row } from './native-chat-4a-report'
import { seededDbFiles } from './native-chat-4a-sqlite-observer'
import type { Workload } from './native-chat-4a-workloads'

export const FAMILIES = [
  'conversion',
  'send',
  'stream',
  'history',
  'outline',
  'records',
  'retained',
  'open',
  'rewind',
  'memory'
] as const
export type Family = (typeof FAMILIES)[number]
export type SeededProfile = { seedDir: string; manifest: Manifest }
const seededChatCount = (manifest: Manifest): number =>
  1 + Number(manifest.mediumSessionId !== null) + manifest.fillerSessionIds.length

export async function runArm(input: {
  arm: Arm
  workload: Workload
  log: (line: string) => void
  out: string
  profile?: SeededProfile
  memoryProfile?: SeededProfile
  memorySeedFailure?: string
  stubCommand: string
  families: Set<Family>
  largeSource?: { seedDir: string; manifest: Manifest }
}): Promise<ArmResult> {
  const { workload, log } = input
  const lifecycle = await import('./native-chat-4a-ops-lifecycle')
  const conversion = await import('./native-chat-4a-ops-conversion')
  const queue = await import('./native-chat-4a-ops-queue')
  const retained = await import('./native-chat-4a-ops-retained')
  const stream = await import('./native-chat-4a-ops-stream')
  const reads = await import('./native-chat-4a-ops-reads')
  const shapes = await import('./native-chat-4a-ops-shapes')
  const forkPressure = await import('./native-chat-4a-ops-fork-pressure')
  const rows: Row[] = []
  const startedAt = new Date().toISOString()

  const onProfile = profileRunner({
    arm: input.arm,
    out: input.out,
    stubCommand: input.stubCommand,
    workload,
    rows,
    log
  })

  let steadyStateReady = true
  const run = async (family: Family, body: () => Promise<void>) => {
    if (!input.families.has(family)) {
      return
    }
    if (!steadyStateReady && family !== 'conversion' && family !== 'memory') {
      rows.push({
        family,
        operation: '(family)',
        variant: 'all',
        samples: [],
        context: {},
        skipped:
          'not run: seeded conversion guard did not establish readiness; see conversion evidence'
      })
      return
    }
    log(`${input.arm.name}: ${family}`)
    try {
      await body()
    } catch (error) {
      const reason =
        `family failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
      if (family === 'memory') {
        memory.skipMissingMemoryRows(rows, workload, reason)
      } else {
        rows.push({
          family,
          operation: '(family)',
          variant: 'all',
          samples: [],
          context: {},
          skipped: reason
        })
      }
      log(`${input.arm.name}: ${family} ${reason}`)
    }
  }

  const profile = input.profile
  if (profile) {
    const label = `${workload.history.largeTurns}-turn/${seededChatCount(profile.manifest)}-chat profile`
    if (input.families.has('conversion')) {
      // A copy of its own, left idle, so the sweep's whole duration and per-chat intervals carry no foreground work.
      await onProfile(profile.seedDir, profile.manifest, 'sweep', (ctx, observer) =>
        run('conversion', () => conversion.sweepRows(ctx, observer, label))
      )
    }
    await onProfile(profile.seedDir, profile.manifest, 'families', async (ctx, observer) => {
      const seedFiles = seededDbFiles(profile.seedDir)
      // First: the seeded tail markers and unconverted state exist only before any other family writes.
      await run('conversion', () => conversion.firstLaunchRows(ctx, seedFiles, label, observer))
      steadyStateReady = false
      try {
        steadyStateReady = await conversion.awaitSweep(ctx, observer, label)
      } catch (error) {
        rows.push({
          family: 'conversion',
          operation: 'steady-state readiness guard',
          variant: label,
          samples: [],
          context: {},
          skipped: `guard failed: ${String(error).slice(0, 250)}`
        })
      }
      await run('outline', () => forkPressure.forkPressureRows(ctx))
      await run('send', () => queue.sendAndQueueRows(ctx))
      await run('stream', () => stream.streamingRows(ctx))
      await run('history', async () => {
        await reads.historyRows(ctx)
        await shapes.subagentRows(ctx)
        await shapes.itemShapeRows(ctx)
      })
      await run('outline', () => reads.outlineAndForkRows(ctx))
      await run('records', () => reads.recordRows(ctx))
      await run('retained', () => retained.retainedAdmissionRows(ctx))
      await run('open', () => lifecycle.openRows(ctx))
      await run('rewind', () => lifecycle.rewindRows(ctx))
    })
  }
  await run('memory', async () => {
    if (!input.memoryProfile) {
      throw new Error(input.memorySeedFailure ?? 'memory seed unavailable')
    }
    const source = input.memoryProfile
    await onProfile(
      source.seedDir,
      source.manifest,
      'memory',
      convertedMemoryRows,
      memory.memoryWorkload(workload)
    )
  })
  if (input.largeSource && input.families.has('conversion')) {
    const source = input.largeSource
    const sourceLabel = `${(workload.conversionSourceBytes / 1024 ** 3).toFixed(0)} GiB source`
    await onProfile(source.seedDir, source.manifest, 'large-source', (ctx, observer) =>
      run('conversion', () =>
        conversion.firstLaunchRows(ctx, seededDbFiles(source.seedDir), sourceLabel, observer)
      )
    )
  }
  const manifest = profile?.manifest ?? input.memoryProfile?.manifest
  return {
    arm: input.arm.name,
    sha: input.arm.sha,
    provenance: input.arm.provenance,
    startedAt,
    finishedAt: new Date().toISOString(),
    rows,
    fixture: {
      repoId: manifest?.workspace.repoId ?? 'unavailable',
      worktreeIds: manifest?.workspace.worktreeIds.join(' ') ?? 'unavailable',
      seedArm: manifest?.seedArm ?? 'unavailable',
      seedSha: manifest?.seedSha ?? 'unavailable',
      recipe: manifest?.recipe ?? 'unavailable',
      largeSourceRecipe: input.largeSource?.manifest.recipe ?? 'none',
      largeItems: manifest?.largeItems ?? 0,
      storageBytes: manifest?.storageBytes ?? 0,
      seedMs: manifest?.seedMs ?? 0,
      memoryRecipe:
        input.memoryProfile?.manifest.recipe ?? input.memorySeedFailure ?? 'not selected',
      memorySeedMs: input.memoryProfile?.manifest.seedMs ?? 'unavailable',
      memorySeedProfileLogicalBytes: input.memoryProfile?.manifest.profileBytes ?? 'unavailable'
    }
  }
}
