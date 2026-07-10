import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseReportGateArgs,
  runTerminalScalePerfReportGate
} from './run-terminal-scale-perf-report-gate.mjs'

const tempDirs = []

function tempReportPath() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-terminal-perf-gate-'))
  tempDirs.push(dir)
  return join(dir, 'report.json')
}

function makeSpawnSync({ onScaleRun, scaleStatus = 0 } = {}) {
  const calls = []
  const spawnSyncImpl = vi.fn((command, args, options) => {
    calls.push({ args, command, options })
    if (args[0] === 'config/scripts/run-terminal-scale-perf-e2e.mjs') {
      onScaleRun?.()
      writeSync(options.stdio[1], '{"suites":[]}')
      return { signal: null, status: scaleStatus }
    }
    return { signal: null, status: 0 }
  })
  return { calls, spawnSyncImpl }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('run-terminal-scale-perf-report-gate', () => {
  it('parses report path flags while forwarding remaining Playwright args', () => {
    expect(
      parseReportGateArgs(['--', '--report', 'tmp/report.json', '--grep', 'ACK-backpressured'])
    ).toEqual({
      passthroughArgs: ['--grep', 'ACK-backpressured'],
      reportPath: 'tmp/report.json'
    })

    expect(parseReportGateArgs(['--output=out.json'], {})).toEqual({
      passthroughArgs: [],
      reportPath: 'out.json'
    })
  })

  it('rejects ambiguous report paths and reporter overrides', () => {
    expect(() => parseReportGateArgs(['--report', '--grep', 'ACK'])).toThrow(
      '--report requires a path'
    )
    expect(() => parseReportGateArgs(['--reporter=line'])).toThrow(
      'test:e2e:terminal-perf:scale:report always uses --reporter=json'
    )
    expect(() => parseReportGateArgs(['--reporter', 'line'])).toThrow(
      'test:e2e:terminal-perf:scale:report always uses --reporter=json'
    )
  })

  it('runs the scale suite with JSON output, then summarizes and budget-checks the report', () => {
    const reportPath = tempReportPath()
    const { calls, spawnSyncImpl } = makeSpawnSync()

    const status = runTerminalScalePerfReportGate({
      argv: ['--report', reportPath, '--grep', '25 ACK-backpressured real PTYs'],
      env: { ...process.env, ORCA_TEST_MARKER: '1' },
      spawnSyncImpl
    })

    expect(status).toBe(0)
    expect(readFileSync(reportPath, 'utf8')).toBe('{"suites":[]}')
    expect(calls.map((call) => call.args[0])).toEqual([
      'config/scripts/run-terminal-scale-perf-e2e.mjs',
      'config/scripts/summarize-terminal-perf-report.mjs',
      'config/scripts/check-terminal-perf-report-budgets.mjs'
    ])
    expect(calls[0].args).toEqual([
      'config/scripts/run-terminal-scale-perf-e2e.mjs',
      '--',
      '--reporter=json',
      '--grep',
      '25 ACK-backpressured real PTYs'
    ])
    expect(calls[0].options.env.ORCA_TEST_MARKER).toBe('1')
    expect(calls[1].args).toEqual(['config/scripts/summarize-terminal-perf-report.mjs', reportPath])
    expect(calls[2].args).toEqual([
      'config/scripts/check-terminal-perf-report-budgets.mjs',
      reportPath
    ])
  })

  it('uses the report path from env when no flag is provided', () => {
    const reportPath = tempReportPath()
    const { calls, spawnSyncImpl } = makeSpawnSync()

    const status = runTerminalScalePerfReportGate({
      env: { ...process.env, ORCA_E2E_TERMINAL_PERF_REPORT_PATH: reportPath },
      spawnSyncImpl
    })

    expect(status).toBe(0)
    expect(calls[1].args).toEqual(['config/scripts/summarize-terminal-perf-report.mjs', reportPath])
  })

  it('preserves the report when Playwright clears the target report directory', () => {
    const reportPath = tempReportPath()
    const { spawnSyncImpl } = makeSpawnSync({
      onScaleRun: () => {
        rmSync(dirname(reportPath), { force: true, recursive: true })
      }
    })

    const status = runTerminalScalePerfReportGate({
      argv: ['--report', reportPath],
      spawnSyncImpl
    })

    expect(status).toBe(0)
    expect(readFileSync(reportPath, 'utf8')).toBe('{"suites":[]}')
  })

  it('stops before summarize and budget checks when the scale run fails', () => {
    const reportPath = tempReportPath()
    const { calls, spawnSyncImpl } = makeSpawnSync({ scaleStatus: 7 })

    const status = runTerminalScalePerfReportGate({
      argv: ['--report', reportPath],
      spawnSyncImpl
    })

    expect(status).toBe(7)
    expect(calls.map((call) => call.args[0])).toEqual([
      'config/scripts/run-terminal-scale-perf-e2e.mjs'
    ])
  })
})
