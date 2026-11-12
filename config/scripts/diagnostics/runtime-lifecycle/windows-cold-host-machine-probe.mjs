import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { runProcess } from '@orca/process-host'

if (process.platform !== 'win32') {
  console.log(JSON.stringify({ skipped: true, reason: 'Requires native Windows' }))
} else {
  const output = resolve('.build/windows-native-benchmark')
  mkdirSync(output, { recursive: true })
  const executable = resolve(output, 'cold-host-machine-probe.cjs')
  await build({
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: 'cold-host-machine-probe.ts',
      loader: 'ts',
      contents: `
import { basename } from 'node:path'
import { setSpawnObserver } from '@orca/process-host/spawn-observer'
import { readHostMachineWithin } from './src/main/runtime/hosts/platform-probe/runtime-host-machine'

async function measure() {
  const spawns = []
  const events = []
  setSpawnObserver((command, _args, blockMs) => spawns.push({ command: basename(command), blockMs }))
  const startedAt = performance.now()
  const tick = setInterval(() => events.push(performance.now() - startedAt), 100)
  try {
    for (const phase of ['cold', 'same-process-repeat']) {
      const start = performance.now()
      const pending = readHostMachineWithin(750)
      const returnedPromiseMs = performance.now() - start
      const machine = await pending
      console.log(JSON.stringify({ phase, host: { platform: process.platform, arch: process.arch, node: process.versions.node }, returnedPromiseMs, settledMs: performance.now() - start, machine, spawns: [...spawns], events: [...events] }))
    }
  } finally {
    clearInterval(tick)
    setSpawnObserver(null)
  }
}
measure().catch(error => { console.error(error); process.exitCode = 1 })
`
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['*.node'],
    outfile: executable
  })
  const result = await runProcess({
    program: process.execPath,
    args: [executable],
    timeoutMs: 30_000,
    maxOutputBytes: 128 * 1024
  })
  console.log(result.stdout)
  console.error(result.stderr)
  writeFileSync(resolve(output, 'cold-host-machine-probe.jsonl'), result.stdout)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.timedOut, false)
}
