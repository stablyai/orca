import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = 'config/scripts/check-terminal-perf-report-budgets.mjs'
const tempDirs = []

function writeReport(annotationDescription, annotationType = 'opencode-test') {
  const dir = mkdtempSync(join(tmpdir(), 'orca-terminal-perf-report-'))
  tempDirs.push(dir)
  const reportPath = join(dir, 'report.json')
  writeFileSync(
    reportPath,
    JSON.stringify({
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  annotations: [
                    {
                      type: annotationType,
                      description: annotationDescription
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })
  )
  return reportPath
}

function runChecker(reportPath) {
  return spawnSync(process.execPath, [scriptPath, reportPath], {
    cwd: process.cwd(),
    encoding: 'utf8'
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('check-terminal-perf-report-budgets', () => {
  it('passes reports whose OpenCode terminal perf annotations stay within budgets', () => {
    const reportPath = writeReport(
      [
        'panes=51',
        'frames=180',
        'median=2.9ms',
        'worst=5.9ms',
        'maxTimerDrift=12.1ms',
        'scroll=149.9ms',
        'restore=642.0ms',
        'rendererQueuedChars=0',
        'rendererPeakQueuedChars=2097152',
        'rendererDroppedBacklogs=0'
      ].join(' ')
    )

    const output = execFileSync(process.execPath, [scriptPath, reportPath], {
      cwd: process.cwd(),
      encoding: 'utf8'
    })

    expect(output).toContain('Terminal perf budget check passed for 1 annotation row(s).')
  })

  it('fails reports with over-budget metrics', () => {
    const reportPath = writeReport(
      [
        'panes=101',
        'frames=60',
        'median=76.0ms',
        'worst=301.0ms',
        'maxTimerDrift=151.0ms',
        'scroll=151.0ms',
        'restore=1001.0ms',
        'rendererQueuedChars=2097153',
        'rendererPeakQueuedChars=2097153',
        'rendererDroppedBacklogs=1'
      ].join(' ')
    )

    const result = runChecker(reportPath)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('median typing latency 76ms exceeded budget 75ms')
    expect(result.stderr).toContain('worst typing latency 301ms exceeded budget 300ms')
    expect(result.stderr).toContain('timer drift 151ms exceeded budget 150ms')
    expect(result.stderr).toContain('scroll latency 151ms exceeded budget 150ms')
    expect(result.stderr).toContain('restore latency 1001ms exceeded budget 1000ms')
    expect(result.stderr).toContain('renderer queued chars 2097153 exceeded budget 2097152')
    expect(result.stderr).toContain('renderer peak queued chars 2097153 exceeded budget 2097152')
    expect(result.stderr).toContain('renderer dropped backlogs 1 exceeded budget 0')
  })

  it('fails malformed metric values instead of treating them as absent', () => {
    const reportPath = writeReport('panes=1 median=999 worst=abcms rendererQueuedChars=wat')

    const result = runChecker(reportPath)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('median value "999" is malformed')
    expect(result.stderr).toContain('worst value "abcms" is malformed')
    expect(result.stderr).toContain('rendererQueuedChars value "wat" is malformed')
    expect(result.stderr).toContain('no recognized budget metrics found')
  })

  it('fails OpenCode annotation rows that contain no budget metrics', () => {
    const reportPath = writeReport('panes=1 frames=60')

    const result = runChecker(reportPath)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no recognized budget metrics found')
  })

  it('ignores non-OpenCode annotations but fails when no perf rows remain', () => {
    const reportPath = writeReport('median=999.0ms', 'browser-unrelated')

    const result = runChecker(reportPath)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('No OpenCode terminal perf annotations found.')
  })
})
