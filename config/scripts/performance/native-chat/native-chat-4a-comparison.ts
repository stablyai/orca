// The 4a "no slower than main" comparison: one profile seeded once, every arm measured on its own copy, one JSON + one table.
// Dry run (no app): pnpm exec tsx config/scripts/performance/native-chat/native-chat-4a-comparison.ts --profile full --dry-run
// Full run:        ... --arm main=<built main checkout> --arm candidate=<built candidate checkout> --profile full --out <dir> [--large-source]
// Re-table:        ... --out <dir> --report-only
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { Arm } from './native-chat-4a-arm'
import type { Manifest } from './native-chat-4a-fixture'
import type { RunContext } from './native-chat-4a-run-context'
import { armMarkdown, writeComparison, type ArmResult, type Row } from './native-chat-4a-report'
import {
  conversionToolOutputBytes,
  dryRunWorkload,
  workloadFor,
  type Workload
} from './native-chat-4a-workloads'

const FAMILIES = [
  'conversion',
  'send',
  'stream',
  'history',
  'outline',
  'records',
  'retained',
  'open',
  'rewind'
] as const
type Family = (typeof FAMILIES)[number]

const { values } = parseArgs({
  options: {
    arm: { type: 'string', multiple: true, default: [] },
    profile: { type: 'string', default: 'smoke' },
    out: { type: 'string' },
    'seed-arm': { type: 'string' },
    families: { type: 'string', default: FAMILIES.join(',') },
    'large-source': { type: 'boolean', default: false },
    'conversion-source-bytes': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'report-only': { type: 'boolean', default: false }
  }
})

const workload = workloadFor(
  values.profile,
  values['conversion-source-bytes'] === undefined
    ? undefined
    : Number(values['conversion-source-bytes'])
)
const log = (line: string): void => console.error(`[4a ${new Date().toISOString()}] ${line}`)

const seededChatCount = (manifest: Manifest): number =>
  1 + Number(manifest.mediumSessionId !== null) + manifest.fillerSessionIds.length

async function runArm(input: {
  arm: Arm
  out: string
  seedDir: string
  manifest: Manifest
  stubCommand: string
  families: Set<Family>
  largeSource?: { seedDir: string; manifest: Manifest }
}): Promise<ArmResult> {
  const { copyProfile, launchArm, stopArm } = await import('./native-chat-4a-arm')
  const { resetTags } = await import('./native-chat-4a-run-context')
  const lifecycle = await import('./native-chat-4a-ops-lifecycle')
  const conversion = await import('./native-chat-4a-ops-conversion')
  const { ConversionObserver } = await import('./native-chat-4a-sqlite-observer')
  const queue = await import('./native-chat-4a-ops-queue')
  const retained = await import('./native-chat-4a-ops-retained')
  const stream = await import('./native-chat-4a-ops-stream')
  const reads = await import('./native-chat-4a-ops-reads')
  const shapes = await import('./native-chat-4a-ops-shapes')
  const profileDir = path.join(input.out, 'profile')
  const rows: Row[] = []
  const startedAt = new Date().toISOString()

  // Each seed copy's first launch converts on the candidate; the observer starts before it, reading only.
  const onProfile = async (
    seedDir: string,
    manifest: typeof input.manifest,
    phase: string,
    body: (ctx: RunContext, observer: InstanceType<typeof ConversionObserver>) => Promise<void>
  ) => {
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
    ctx.relaunch = async () => {
      await stopArm(ctx.launch)
      ctx.launch = await open()
    }
    try {
      await body(ctx, observer)
    } finally {
      await observer.stop()
      await stopArm(ctx.launch)
      renameSync(
        profileDir,
        path.join(
          input.out,
          `after-${input.arm.name}-${phase}-${manifest.toolOutputBytes}-${input.arm.sha.slice(0, 8)}`
        )
      )
    }
  }

  const run = async (family: Family, body: () => Promise<void>) => {
    if (!input.families.has(family)) {
      return
    }
    log(`${input.arm.name}: ${family}`)
    try {
      await body()
    } catch (error) {
      const reason =
        `family failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
      rows.push({
        family,
        operation: '(family)',
        variant: 'all',
        samples: [],
        context: {},
        skipped: reason
      })
      log(`${input.arm.name}: ${family} ${reason}`)
    }
  }

  const label = `${workload.history.largeTurns}-turn/${seededChatCount(input.manifest)}-chat profile`
  if (input.families.has('conversion')) {
    // A copy of its own, left idle, so the sweep's whole duration and per-chat intervals carry no foreground work.
    await onProfile(input.seedDir, input.manifest, 'sweep', (ctx, observer) =>
      run('conversion', () => conversion.sweepRows(ctx, observer, label))
    )
  }
  await onProfile(input.seedDir, input.manifest, 'families', async (ctx, observer) => {
    const seedFiles = conversion.seededDbFiles(input.seedDir)
    // First: the seeded tail markers and unconverted state exist only before any other family writes.
    await run('conversion', () => conversion.firstLaunchRows(ctx, seedFiles, label, observer))
    await conversion.awaitSweep(ctx, observer, label)
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
  if (input.largeSource && input.families.has('conversion')) {
    const source = input.largeSource
    const sourceLabel = `${(workload.conversionSourceBytes / 1024 ** 3).toFixed(0)} GiB source`
    await onProfile(source.seedDir, source.manifest, 'large-source', (ctx, observer) =>
      run('conversion', () =>
        conversion.firstLaunchRows(
          ctx,
          conversion.seededDbFiles(source.seedDir),
          sourceLabel,
          observer
        )
      )
    )
  }
  return {
    arm: input.arm.name,
    sha: input.arm.sha,
    startedAt,
    finishedAt: new Date().toISOString(),
    rows,
    fixture: {
      repoId: input.manifest.workspace.repoId,
      worktreeIds: input.manifest.workspace.worktreeIds.join(' '),
      seedArm: input.manifest.seedArm,
      seedSha: input.manifest.seedSha,
      largeItems: input.manifest.largeItems,
      storageBytes: input.manifest.storageBytes,
      seedMs: input.manifest.seedMs
    }
  }
}

async function main(): Promise<void> {
  if (values['dry-run']) {
    console.log(JSON.stringify(dryRunWorkload(workload), null, 2))
    return
  }
  const out = path.resolve(values.out ?? path.join(os.tmpdir(), `orca-4a-${workload.profile}`))
  mkdirSync(out, { recursive: true })
  if (values['report-only']) {
    const results = readdirSync(out)
      .filter((file) => /^arm-.*\.json$/.test(file))
      .map((file): ArmResult => JSON.parse(readFileSync(path.join(out, file), 'utf8')))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    writeComparison(out, workload, results, log)
    return
  }
  const isFamily = (name: string): name is Family => FAMILIES.some((family) => family === name)
  const families = new Set(
    values.families
      .split(',')
      .map((family) => family.trim())
      .filter(isFamily)
  )
  const { resolveArm, writeProviderStub } = await import('./native-chat-4a-arm')
  const { seedProfile, seedDirFor } = await import('./native-chat-4a-fixture')
  const { createSeededTestRepo } = await import('../../../../tests/e2e/helpers/seeded-test-repo')
  const scratch = path.join(out, 'scratch')
  mkdirSync(scratch, { recursive: true })
  const arms: Arm[] = []
  for (const spec of values.arm) {
    const [name, root] = spec.split('=')
    if (!name || !root) {
      throw new Error(`--arm takes name=checkout, got ${spec}`)
    }
    arms.push(await resolveArm(name, root, scratch))
  }
  if (arms.length === 0) {
    throw new Error('Pass at least one --arm name=<built checkout>; main first, then the candidate')
  }
  const stubCommand = writeProviderStub(path.join(out, 'stub'))
  const repoFile = path.join(out, 'repo-path.txt')
  const repoPath = existsSync(repoFile)
    ? readFileSync(repoFile, 'utf8').trim()
    : createSeededTestRepo({ publishPath: false })
  writeFileSync(repoFile, repoPath)
  const seedArm = arms.find((arm) => arm.name === values['seed-arm']) ?? arms[0]!
  const seed = (toolOutputBytes: number, seeded: Workload) =>
    seedProfile({
      arm: seedArm,
      workload: seeded,
      runDir: out,
      profileDir: path.join(out, 'profile'),
      repoPath,
      stubCommand,
      toolOutputBytes,
      log
    })
  const manifest = await seed(workload.history.toolOutputBytes, workload)
  const large =
    values['large-source'] && workload.conversionSourceBytes > 0
      ? await seed(conversionToolOutputBytes(workload), {
          ...workload,
          history: { ...workload.history, fillerChats: 5, mediumTurns: 0 }
        })
      : null
  const results: ArmResult[] = []
  for (const arm of arms) {
    const result = await runArm({
      arm,
      out,
      seedDir: seedDirFor(out, manifest),
      manifest,
      stubCommand,
      families,
      ...(large ? { largeSource: { seedDir: seedDirFor(out, large), manifest: large } } : {})
    })
    writeFileSync(
      path.join(out, `arm-${arm.name}-${arm.sha.slice(0, 12)}.json`),
      `${JSON.stringify(result, null, 2)}\n`
    )
    writeFileSync(path.join(out, `arm-${arm.name}-${arm.sha.slice(0, 12)}.md`), armMarkdown(result))
    results.push(result)
  }
  writeComparison(out, workload, results, log)
  const skipped = results.flatMap((result) =>
    result.rows
      .filter((row) => row.skipped)
      .map((row) => `${result.arm}: ${row.family}/${row.operation}/${row.variant}: ${row.skipped}`)
  )
  if (skipped.length > 0) {
    log(`rows without samples (not passes):\n${skipped.join('\n')}`)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
