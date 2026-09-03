import { readFileSync, statSync } from 'node:fs'
import { evaluateRecoveryWaveReport } from './relay-recovery-wave-gate.mjs'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--report') {
  process.stderr.write('usage: pnpm load:relay:recovery-gate -- --report <aggregate-report.json>\n')
  process.exitCode = 1
} else {
  try {
    if (statSync(args[1]).size > 1024 * 1024) throw new Error('report exceeds 1 MiB')
    const report = JSON.parse(readFileSync(args[1], 'utf8'))
    const result = evaluateRecoveryWaveReport(report)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.status !== 'PASS') process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
