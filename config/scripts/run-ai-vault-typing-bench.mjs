import { spawn } from 'node:child_process'

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const knobByFlag = {
  '--iterations': 'ORCA_AI_VAULT_BENCH_ITERATIONS',
  '--sessions': 'ORCA_AI_VAULT_BENCH_SESSIONS',
  '--payload-kib': 'ORCA_AI_VAULT_BENCH_PAYLOAD_KIB',
  '--keys': 'ORCA_AI_VAULT_BENCH_KEYS',
  '--cadence-ms': 'ORCA_AI_VAULT_BENCH_CADENCE_MS',
  '--label': 'ORCA_AI_VAULT_BENCH_LABEL'
}

const env = { ...process.env, ORCA_AI_VAULT_TYPING_BENCH: '1' }
const passthroughArgs = []
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--') {
    continue
  }
  const knob = knobByFlag[argv[index]]
  if (knob) {
    env[knob] = argv[++index]
  } else {
    passthroughArgs.push(argv[index])
  }
}

const child = spawn(
  npxCommand,
  [
    'playwright',
    'test',
    'tests/e2e/terminal-ai-vault-typing-latency.spec.ts',
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
