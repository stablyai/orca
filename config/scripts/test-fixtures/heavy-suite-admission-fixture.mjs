import { writeFileSync, writeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupE2ERunScope,
  prepareE2ERunScope
} from '../../../tests/e2e/e2e-run-scope-runtime.mts'
import { runHeavyTestSuite } from '../run-heavy-test-suite.mjs'
import { runTerminalScalePerfReportGate } from '../run-terminal-scale-perf-report-gate.mjs'

const fixturePath = import.meta.filename
const [mode, readyFile, signalFile] = process.argv.slice(2)

if (mode === 'child') {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      writeFileSync(signalFile, signal)
      process.exit(0)
    })
  }
  writeFileSync(readyFile, 'ready')
  setInterval(() => {}, 1_000)
} else if (mode === 'runner') {
  let preparedRun = null
  const exitCode = await runHeavyTestSuite({
    suite: 'fixture',
    tempDir: os.tmpdir(),
    prepareRun: () => {
      preparedRun = prepareE2ERunScope({ tempDir: os.tmpdir(), env: {} })
    },
    cleanupRun: () => {
      if (preparedRun) {
        cleanupE2ERunScope(preparedRun.scope, { allowMissingManifest: true })
      }
    },
    steps: [
      {
        command: process.execPath,
        args: [fixturePath, 'child', readyFile, signalFile]
      }
    ]
  })
  process.exitCode = exitCode
} else if (mode === 'report-owner') {
  process.exitCode = await runTerminalScalePerfReportGate({
    argv: ['--report', path.join(os.tmpdir(), 'fixture-report.json')],
    env: process.env,
    runScaleSuite: async ({ stdio }) => {
      writeSync(stdio[1], '{"suites":[]}')
      let preparedRun = null
      return runHeavyTestSuite({
        suite: 'fixture-report-owner',
        tempDir: os.tmpdir(),
        prepareRun: () => {
          preparedRun = prepareE2ERunScope({ tempDir: os.tmpdir(), env: {} })
        },
        cleanupRun: () => {
          if (preparedRun) {
            cleanupE2ERunScope(preparedRun.scope, { allowMissingManifest: true })
          }
        },
        steps: [
          {
            command: process.execPath,
            args: [fixturePath, 'child', readyFile, signalFile]
          }
        ]
      })
    },
    spawnSyncImpl: () => ({ signal: null, status: 0 })
  })
} else {
  throw new Error(`Unknown heavy-suite fixture mode: ${mode}`)
}
