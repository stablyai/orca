/**
 * Entry point for the multi-workspace typing-latency bench
 * (tests/e2e/terminal-multi-workspace-typing-latency.spec.ts).
 *
 * Usage:
 *   pnpm bench:multi-workspace-typing [-- --panes 8 --rate-kbps 512 \
 *     --keys 48 --cadence-ms 250 --cpu-workers 4 --label before-fix]
 *
 * Results land in tools/benchmarks/results/multi-workspace-typing-*.json.
 * Run once per build/config with distinct --label values, then diff the
 * totalMs/inputHalfMs/echoHalfMs percentiles.
 */
import { spawn } from 'node:child_process'

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const knobByFlag = {
  '--panes': 'ORCA_TYPING_BENCH_LOAD_PANES',
  '--rate-kbps': 'ORCA_TYPING_BENCH_RATE_KBPS',
  '--keys': 'ORCA_TYPING_BENCH_KEYS',
  '--cadence-ms': 'ORCA_TYPING_BENCH_KEY_CADENCE_MS',
  '--cpu-workers': 'ORCA_TYPING_BENCH_CPU_WORKERS',
  '--label': 'ORCA_TYPING_BENCH_LABEL'
}

const env = { ...process.env, ORCA_TYPING_BENCH: '1' }
const passthroughArgs = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--') {
    continue
  }
  const knob = knobByFlag[argv[i]]
  if (knob) {
    env[knob] = argv[++i]
  } else {
    passthroughArgs.push(argv[i])
  }
}

const child = spawn(
  npxCommand,
  [
    'playwright',
    'test',
    'tests/e2e/terminal-multi-workspace-typing-latency.spec.ts',
    '--config',
    'tests/playwright.config.ts',
    '--project',
    'electron-headless',
    '--workers=1',
    ...passthroughArgs
  ],
  { stdio: 'inherit', env }
)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
