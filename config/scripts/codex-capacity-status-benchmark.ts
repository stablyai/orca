// Run: ORCA_BACKGROUND_LAUNCH=1 node --import tsx config/scripts/codex-capacity-status-benchmark.ts
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { CodexCapacityNoticeTracker } from '../../src/shared/codex-capacity-notice'
import { HeadlessEmulator } from '../../src/main/daemon/headless-emulator'
import { observeCodexCapacityTerminalStatus } from '../../src/main/runtime/codex-capacity-terminal-status'

const fixture = readFileSync(
  new URL(
    '../../src/main/runtime/__fixtures__/codex-model-capacity-fullscreen.txt',
    import.meta.url
  ),
  'utf8'
)
const notice = fixture.indexOf('■ Selected model')
if (notice === -1) {
  throw new Error('Capacity notice missing from benchmark fixture')
}
const redraw = fixture.slice(0, fixture.lastIndexOf('\x1b[?2026h', notice))
const scenarios = [
  { name: 'plain-4K', data: 'x'.repeat(4096), iterations: 30_000 },
  { name: 'captured-TUI', data: redraw, iterations: 30_000 },
  {
    name: 'warning-footer',
    data: '\x1b[?2026h\x1b[21;1H⚠ 1 warning · f2 to view\x1b[?2026l',
    iterations: 30_000
  },
  { name: 'tiny-typing', data: 'a', iterations: 30_000 },
  { name: 'marker-flood', data: '■'.repeat(4096), iterations: 1000 },
  {
    name: 'large-after-warning',
    data: `⚠ unrelated\n${'x'.repeat(1024 * 1024)}`,
    iterations: 128
  }
]

function measure(iterations: number, observe: () => void): number {
  const start = performance.now()
  for (let index = 0; index < iterations; index++) {
    observe()
  }
  return performance.now() - start
}

for (const scenario of scenarios) {
  const run = () => {
    const tracker = new CodexCapacityNoticeTracker()
    let screenReads = 0
    const readScreen = () => {
      screenReads++
      return []
    }
    const elapsedMs = measure(scenario.iterations, () => tracker.observe(scenario.data, readScreen))
    if (screenReads !== 0) {
      throw new Error(`${scenario.name} read the screen ${screenReads} times`)
    }
    return elapsedMs
  }
  run()
  const samples = Array.from({ length: 5 }, run).sort((left, right) => left - right)
  const elapsedMs = samples[2]
  textResult(scenario.name, elapsedMs, scenario.iterations, scenario.data.length)
}

for (const launchAgent of [undefined, 'codex'] as const) {
  const emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
  const data = 'x'.repeat(4096)
  const iterations = 30_000
  let statusReads = 0
  const readStatus = () => {
    statusReads++
    return undefined
  }
  try {
    const observe = () =>
      observeCodexCapacityTerminalStatus(
        emulator,
        data,
        'node /some/wrapper.cjs',
        launchAgent,
        readStatus,
        1
      )
    measure(iterations, observe)
    const samples = Array.from({ length: 5 }, () => measure(iterations, observe)).sort(
      (left, right) => left - right
    )
    if (statusReads !== 0) {
      throw new Error(`Ordinary output read status ${statusReads} times`)
    }
    textResult(launchAgent ?? 'unrelated-terminal', samples[2], iterations, data.length)
  } finally {
    emulator.dispose()
  }
}

async function measureScreenRead(): Promise<void> {
  const emulator = new HeadlessEmulator({ cols: 40, rows: 24 })
  try {
    await emulator.write(fixture)
    for (const name of ['screen-only', 'capacity-parse-and-screen']) {
      const observe = () => {
        if (name === 'screen-only') {
          emulator.getVisibleLines()
        } else if (
          !new CodexCapacityNoticeTracker().observe(fixture, () => emulator.getVisibleLines())
        ) {
          throw new Error('Captured capacity notice was not detected')
        }
      }
      measure(1000, observe)
      const samples = Array.from({ length: 5 }, () => measure(1000, observe)).sort(
        (left, right) => left - right
      )
      textResult(name, samples[2], 1000, fixture.length)
    }
  } finally {
    emulator.dispose()
  }
}

void measureScreenRead().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

function textResult(name: string, elapsedMs: number, iterations: number, chars: number): void {
  console.log(
    JSON.stringify({
      name,
      chars,
      iterations,
      microsecondsPerChunk: Number(((elapsedMs * 1000) / iterations).toFixed(3)),
      millisecondsPerMiB: Number((elapsedMs / ((chars * iterations) / 1048576)).toFixed(3))
    })
  )
}
