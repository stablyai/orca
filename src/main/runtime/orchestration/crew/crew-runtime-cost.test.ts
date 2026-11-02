import { writeFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { emptyCrew, type OrchestrationCrewSnapshot } from '../../../../shared/orchestration-crew'
import { CrewReadModel } from './crew-read-model'
import { subscribeCrew } from './crew-stream'
import { CREW_COST_CORPUS, crewRuntimeCostCorpus } from './crew-runtime-cost.test-fixture'
import { meterCrewSql, sqlTotals } from './crew-recipient-sql.test-fixture'

type Corpus = ReturnType<typeof crewRuntimeCostCorpus>
type Phase = keyof Corpus['actions']
const phases: Phase[] = ['names', 'status', 'traffic', 'topology']
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

function mounted(corpus: Corpus, subscribers: number) {
  const model = new CrewReadModel(corpus.dependencies, corpus.watch)
  let reads = 0
  let completed = 0
  const current = new Map<string, OrchestrationCrewSnapshot>()
  const stops = corpus.addresses(subscribers).map((address) => {
    let pending = emptyCrew('unknown')
    return subscribeCrew(
      () => {
        reads++
        return model.read(address)
      },
      model.subscribe,
      (frame) => {
        if (frame.type === 'begin') {
          pending = emptyCrew(frame.status)
        } else if (frame.type === 'rows') {
          pending.sections[frame.section].push(...frame.rows)
        } else if (frame.type === 'complete') {
          completed++
          current.set(address, pending)
        }
      }
    )
  })
  return {
    stop: () => stops.forEach((stop) => stop()),
    reads: () => reads,
    completed: () => completed,
    coordinator: () => current.get('term_coord')!
  }
}

function verifyUpdate(
  corpus: Corpus,
  stream: ReturnType<typeof mounted>,
  phase: Phase,
  result: unknown
) {
  const worker = stream.coordinator().sections.managing[0]
  expect(worker).toBeDefined()
  if (phase === 'names') {
    expect(worker.label).toBe(corpus.expectedName())
  } else if (phase === 'status') {
    expect(worker.status).toBe(corpus.expectedState())
  } else if (phase === 'traffic') {
    expect(worker.latest?.preview).toBe(result)
  }
  expect(worker.pendingQuestion?.preview).toMatch(/^Pending decision /)
}

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const rounded = (value: number) => Number(value.toFixed(3))
  return {
    median: rounded(sorted[Math.floor(sorted.length / 2)]),
    p95: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    max: rounded(sorted.at(-1)!),
    samples: samples.map(rounded)
  }
}

async function measuredUpdates(corpus: Corpus, stream: ReturnType<typeof mounted>) {
  const timings: Record<
    string,
    { wallMs: ReturnType<typeof summary>; cpuMs: ReturnType<typeof summary> }
  > = {}
  for (const phase of phases) {
    const wall: number[] = []
    const cpu: number[] = []
    for (let trial = 0; trial < 5; trial++) {
      const cpuStart = process.cpuUsage()
      const start = performance.now()
      const result = corpus.actions[phase]()
      await flush()
      wall.push(performance.now() - start)
      const usage = process.cpuUsage(cpuStart)
      cpu.push((usage.user + usage.system) / 1000)
      verifyUpdate(corpus, stream, phase, result)
    }
    timings[phase] = { wallMs: summary(wall), cpuMs: summary(cpu) }
  }
  return timings
}

async function countedUpdates(corpus: Corpus, stream: ReturnType<typeof mounted>) {
  const nativeClone = globalThis.structuredClone
  const clones = { calls: 0, jsonBytes: 0, irrelevantWorkspaceClones: 0 }
  const cloneSpy = vi.spyOn(globalThis, 'structuredClone').mockImplementation((value, options) => {
    clones.calls++
    clones.jsonBytes += Buffer.byteLength(JSON.stringify(value) ?? '')
    if (value && typeof value === 'object' && 'costIrrelevantWorkspaceState' in value) {
      clones.irrelevantWorkspaceClones++
    }
    return nativeClone(value, options)
  })
  const meter = meterCrewSql(corpus.db.db)
  const counts: Record<string, unknown> = {}
  try {
    for (const phase of phases) {
      clones.calls = clones.jsonBytes = clones.irrelevantWorkspaceClones = 0
      meter.executions.length = 0
      corpus.counters.statusAcquisitions = corpus.counters.dependencyAcquisitions = 0
      const beforeReads = stream.reads()
      const beforeCompleted = stream.completed()
      const result = corpus.actions[phase]()
      await flush()
      const sql = sqlTotals(meter.executions)
      counts[phase] = {
        ...clones,
        ...corpus.counters,
        snapshotReads: stream.reads() - beforeReads,
        publications: stream.completed() - beforeCompleted,
        sql
      }
      verifyUpdate(corpus, stream, phase, result)
      expect(clones.irrelevantWorkspaceClones).toBe(0)
      if (phase === 'names') {
        expect(sql.all).toBe(0)
        expect(sql.get).toBe(0)
        expect(clones.jsonBytes).toBeLessThanOrEqual(1024)
      } else if (phase === 'status' || phase === 'traffic') {
        expect(sql.all).toBeLessThanOrEqual(2)
      } else if (phase === 'topology') {
        expect(clones.jsonBytes).toBeLessThan(100_000)
      }
    }
  } finally {
    meter.restore()
    cloneSpy.mockRestore()
  }
  return counts
}

it('reports finite production-seam costs at installed scale with separate clean timing and counters', async () => {
  const corpus = crewRuntimeCostCorpus()
  const reports: {
    workspaceBytes: number
    subscribers: number
    actualWorkspaceBytes: number
    initialWallMs: number
    initialCpuMs: number
    timings: Awaited<ReturnType<typeof measuredUpdates>>
    counts: Awaited<ReturnType<typeof countedUpdates>>
  }[] = []
  for (const setup of [
    { workspaceBytes: 406_443, subscribers: 1 },
    { workspaceBytes: 4_064_436, subscribers: 1 },
    { workspaceBytes: 4_064_436, subscribers: 10 },
    { workspaceBytes: 4_064_436, subscribers: 172 }
  ]) {
    corpus.setWorkspaceBytes(setup.workspaceBytes)
    const cpuStart = process.cpuUsage()
    const started = performance.now()
    const stream = mounted(corpus, setup.subscribers)
    const initialWallMs = performance.now() - started
    const initialCpu = process.cpuUsage(cpuStart)
    try {
      await flush()
      const timings = await measuredUpdates(corpus, stream)
      const counts = await countedUpdates(corpus, stream)
      reports.push({
        ...setup,
        actualWorkspaceBytes: corpus.workspaceBytes(),
        initialWallMs: Number(initialWallMs.toFixed(3)),
        initialCpuMs: Number(((initialCpu.user + initialCpu.system) / 1000).toFixed(3)),
        timings,
        counts
      })
    } finally {
      stream.stop()
    }
    const reads = stream.reads()
    corpus.actions.names()
    corpus.actions.status()
    corpus.actions.traffic()
    corpus.actions.topology()
    await flush()
    expect(stream.reads()).toBe(reads)
  }
  const report = {
    corpus: { ...CREW_COST_CORPUS, recordJsonBytes: corpus.recordBytes },
    trials: 5,
    boundary:
      'Synthetic identities and hook rows; real captured fleet qualification, sender naming, SQLite, read model and stream. Excludes Electron/RPC/rendering. Topology means subscribed host reacquisition. Clone bytes are JSON-size proxies measured only in counter pass.',
    reports
  }
  const reportPath = process.env.ORCA_CREW_COST_REPORT_PATH
  if (reportPath) {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }
  console.info(`CREW_RUNTIME_COST ${JSON.stringify(report)}`)
}, 120_000)
