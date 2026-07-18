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

function makeProcessRunners({ onScaleRun, scaleStatus = 0 } = {}) {
  const calls = []
  const runScaleSuite = vi.fn(async ({ args, env, stdio }) => {
    calls.push({ args: ['scale-suite', ...args], command: 'scale-suite', options: { env, stdio } })
    onScaleRun?.()
    writeSync(stdio[1], '{"suites":[]}')
    return scaleStatus
  })
  const spawnSyncImpl = vi.fn((command, args, options) => {
    calls.push({ args, command, options })
    return { signal: null, status: 0 }
  })
  return { calls, runScaleSuite, spawnSyncImpl }
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

  it('runs the scale suite with JSON output, then summarizes and budget-checks the report', async () => {
    const reportPath = tempReportPath()
    const { calls, runScaleSuite, spawnSyncImpl } = makeProcessRunners()

    const status = await runTerminalScalePerfReportGate({
      argv: ['--report', reportPath, '--grep', '25 ACK-backpressured real PTYs'],
      env: { ...process.env, ORCA_TEST_MARKER: '1' },
      runScaleSuite,
      spawnSyncImpl
    })

    expect(status).toBe(0)
    expect(readFileSync(reportPath, 'utf8')).toBe('{"suites":[]}')
    expect(calls.map((call) => call.args[0])).toEqual([
      'scale-suite',
      'config/scripts/summarize-terminal-perf-report.mjs',
      'config/scripts/check-terminal-perf-report-budgets.mjs',
      'config/scripts/generate-terminal-perf-html-report.mjs'
    ])
    expect(calls[0].args).toEqual([
      'scale-suite',
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
    expect(calls[3].args).toEqual([
      'config/scripts/generate-terminal-perf-html-report.mjs',
      reportPath,
      '--output',
      'test-results/terminal-perf-impact-report.html'
    ])
  })

  it('uses the report path from env when no flag is provided', async () => {
    const reportPath = tempReportPath()
    const { calls, runScaleSuite, spawnSyncImpl } = makeProcessRunners()

    const status = await runTerminalScalePerfReportGate({
      env: { ...process.env, ORCA_E2E_TERMINAL_PERF_REPORT_PATH: reportPath },
      runScaleSuite,
      spawnSyncImpl
    })

    expect(status).toBe(0)
    expect(calls[1].args).toEqual(['config/scripts/summarize-terminal-perf-report.mjs', reportPath])
  })

  it('uses the HTML report path from env when provided', async () => {
    const reportPath = tempReportPath()
    const { calls, runScaleSuite, spawnSyncImpl } = makeProcessRunners()

    const status = await runTerminalScalePerfReportGate({
      env: {
        ...process.env,
        ORCA_E2E_TERMINAL_PERF_HTML_REPORT_PATH: 'tmp/terminal-report.html',
        ORCA_E2E_TERMINAL_PERF_REPORT_PATH: reportPath
      },
      runScaleSuite,
      spawnSyncImpl
    })

    expect(status).toBe(0)
    expect(calls[3].args).toEqual([
      'config/scripts/generate-terminal-perf-html-report.mjs',
      reportPath,
      '--output',
      'tmp/terminal-report.html'
    ])
  })

  it('preserves the report when Playwright clears the target report directory', async () => {
    const reportPath = tempReportPath()
    const { runScaleSuite, spawnSyncImpl } = makeProcessRunners({
      onScaleRun: () => {
        rmSync(dirname(reportPath), { force: true, recursive: true })
      }
    })

    const status = await runTerminalScalePerfReportGate({
      argv: ['--report', reportPath],
      runScaleSuite,
      spawnSyncImpl
    })

    expect(status).toBe(0)
    expect(readFileSync(reportPath, 'utf8')).toBe('{"suites":[]}')
  })

  it('stops before summarize and budget checks when the scale run fails', async () => {
    const reportPath = tempReportPath()
    const { calls, runScaleSuite, spawnSyncImpl } = makeProcessRunners({ scaleStatus: 7 })

    const status = await runTerminalScalePerfReportGate({
      argv: ['--report', reportPath],
      runScaleSuite,
      spawnSyncImpl
    })

    expect(status).toBe(7)
    expect(calls.map((call) => call.args[0])).toEqual(['scale-suite'])
  })
})
