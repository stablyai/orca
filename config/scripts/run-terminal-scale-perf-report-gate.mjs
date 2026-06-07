import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_REPORT_PATH = 'test-results/terminal-scale-perf-report.json'

export function parseReportGateArgs(argv, env = process.env) {
  const forwardedArgs = [...argv]
  if (forwardedArgs[0] === '--') {
    forwardedArgs.shift()
  }

  let reportPath = env.ORCA_E2E_TERMINAL_PERF_REPORT_PATH || DEFAULT_REPORT_PATH
  const passthroughArgs = []
  for (let index = 0; index < forwardedArgs.length; index += 1) {
    const arg = forwardedArgs[index]
    if (arg === '--report' || arg === '--report-path' || arg === '--output') {
      const next = forwardedArgs[index + 1]
      if (!next || next.startsWith('-')) {
        throw new Error(`${arg} requires a path`)
      }
      reportPath = next
      index += 1
      continue
    }
    if (
      arg.startsWith('--report=') ||
      arg.startsWith('--report-path=') ||
      arg.startsWith('--output=')
    ) {
      reportPath = arg.slice(arg.indexOf('=') + 1)
      continue
    }
    if (arg === '--reporter' || arg.startsWith('--reporter=')) {
      throw new Error('test:e2e:terminal-perf:scale:report always uses --reporter=json')
    }
    passthroughArgs.push(arg)
  }

  return { passthroughArgs, reportPath }
}

function runNodeScript(scriptPath, args, stdio, spawnSyncImpl, env) {
  return spawnSyncImpl(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    env,
    stdio
  })
}

function exitCode(result) {
  if (result.signal) {
    console.error(`Terminal scale perf command exited with signal ${result.signal}`)
    return 1
  }
  return result.status ?? 1
}

export function runTerminalScalePerfReportGate({
  argv = process.argv.slice(2),
  env = process.env,
  spawnSyncImpl = spawnSync
} = {}) {
  const { passthroughArgs, reportPath } = parseReportGateArgs(argv, env)
  const tempDir = mkdtempSync(join(tmpdir(), 'orca-terminal-scale-perf-'))
  const tempReportPath = join(tempDir, 'report.json')

  let scaleExitCode
  try {
    const reportFd = openSync(tempReportPath, 'w')
    let scaleResult
    try {
      scaleResult = runNodeScript(
        'config/scripts/run-terminal-scale-perf-e2e.mjs',
        ['--', '--reporter=json', ...passthroughArgs],
        ['inherit', reportFd, 'inherit'],
        spawnSyncImpl,
        env
      )
    } finally {
      closeSync(reportFd)
    }

    scaleExitCode = exitCode(scaleResult)
    mkdirSync(dirname(reportPath), { recursive: true })
    copyFileSync(tempReportPath, reportPath)
  } finally {
    rmSync(tempDir, { force: true, recursive: true })
  }

  if (scaleExitCode !== 0) {
    console.error(`Terminal scale perf report saved to ${reportPath}`)
    return scaleExitCode
  }

  console.log(`Terminal scale perf report saved to ${reportPath}`)
  const summaryResult = runNodeScript(
    'config/scripts/summarize-terminal-perf-report.mjs',
    [reportPath],
    'inherit',
    spawnSyncImpl,
    env
  )
  const summaryExitCode = exitCode(summaryResult)
  if (summaryExitCode !== 0) {
    return summaryExitCode
  }

  const budgetResult = runNodeScript(
    'config/scripts/check-terminal-perf-report-budgets.mjs',
    [reportPath],
    'inherit',
    spawnSyncImpl,
    env
  )
  return exitCode(budgetResult)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runTerminalScalePerfReportGate())
}
