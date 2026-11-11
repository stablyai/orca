// The 4a "no slower than main" comparison: one profile seeded once, every arm measured on its own copy, one JSON + one table.
// Dry run (no app): pnpm exec tsx config/scripts/performance/native-chat/native-chat-4a-comparison.ts --profile full --dry-run
// Full run:        ... --arm main=<built main checkout>@<full sha> --arm candidate=<built candidate checkout>@<full sha> --profile full --out <dir> [--large-source]
// Re-table:        ... --out <dir> --report-only [--arm main=@<full sha> --arm candidate=@<full sha>]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { Arm } from './native-chat-4a-arm'
import { assertOneRun, parseArmSpec, seededBy } from './native-chat-4a-arm-provenance'
import { FAMILIES, runArm, type Family } from './native-chat-4a-comparison-arm'
import * as memory from './native-chat-4a-ops-memory'
import { seedMemoryProfile } from './native-chat-4a-memory-profile'
import { armMarkdown, writeComparison, type ArmResult } from './native-chat-4a-report'
import {
  conversionToolOutputBytes,
  dryRunWorkload,
  workloadFor,
  type Workload
} from './native-chat-4a-workloads'

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

async function main(): Promise<void> {
  if (values['dry-run']) {
    console.log(
      JSON.stringify({ ...dryRunWorkload(workload), memory: memory.memoryShape(workload) }, null, 2)
    )
    return
  }
  const out = path.resolve(values.out ?? path.join(os.tmpdir(), `orca-4a-${workload.profile}`))
  mkdirSync(out, { recursive: true })
  if (values['report-only']) {
    const results = readdirSync(out)
      .filter((file) => /^arm-.*\.json$/.test(file))
      .map((file): ArmResult => JSON.parse(readFileSync(path.join(out, file), 'utf8')))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    assertOneRun(results, values.arm.map(parseArmSpec))
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
  for (const spec of values.arm.map(parseArmSpec)) {
    if (!spec.root) {
      throw new Error(`--arm ${spec.name} names no checkout`)
    }
    arms.push(await resolveArm(spec, scratch))
  }
  if (arms.length === 0) {
    throw new Error(
      'Pass at least one --arm name=<built checkout>@<full sha>; main first, then the candidate'
    )
  }
  const stubCommand = writeProviderStub(path.join(out, 'stub'))
  const repoFile = path.join(out, 'repo-path.txt')
  const repoPath = existsSync(repoFile)
    ? readFileSync(repoFile, 'utf8').trim()
    : createSeededTestRepo({ publishPath: false })
  writeFileSync(repoFile, repoPath)
  const seedArm = arms.find((arm) => arm.name === values['seed-arm']) ?? arms[0]!
  const seed = (toolOutputBytes: number, seeded: Workload, runDir = out) =>
    seedProfile({
      arm: seedArm,
      workload: seeded,
      runDir,
      profileDir: path.join(out, 'profile'),
      repoPath,
      stubCommand,
      toolOutputBytes,
      log
    })
  const manifest = [...families].some((family) => family !== 'memory')
    ? seededBy(seedArm, await seed(workload.history.toolOutputBytes, workload))
    : null
  const { memoryProfile, memorySeedFailure } = families.has('memory')
    ? await seedMemoryProfile(
        out,
        workload,
        async (seeded, runDir) =>
          seededBy(seedArm, await seed(seeded.history.toolOutputBytes, seeded, runDir)),
        log
      )
    : {}
  const large =
    families.has('conversion') && values['large-source'] && workload.conversionSourceBytes > 0
      ? seededBy(
          seedArm,
          await seed(conversionToolOutputBytes(workload), {
            ...workload,
            history: { ...workload.history, fillerChats: 5, mediumTurns: 0 }
          })
        )
      : null
  const results: ArmResult[] = []
  for (const arm of arms) {
    const result = await runArm({
      arm,
      out,
      workload,
      log,
      ...(manifest ? { profile: { seedDir: seedDirFor(out, manifest), manifest } } : {}),
      memoryProfile,
      memorySeedFailure,
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
