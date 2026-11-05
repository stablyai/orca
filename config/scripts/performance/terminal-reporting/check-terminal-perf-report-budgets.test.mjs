import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath =
  'config/scripts/performance/terminal-reporting/check-terminal-perf-report-budgets.mjs'
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
  // Redraw scenarios must not inherit the unloaded drift ceiling.

  // Historical outliers must not become the new latency baseline.

  it('fails malformed metric values instead of treating them as absent', () => {
    const reportPath = writeReport('panes=1 median=999 worst=abcms rendererQueuedChars=wat')

    const result = runChecker(reportPath)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('median value "999" is malformed')
    expect(result.stderr).toContain('worst value "abcms" is malformed')
    expect(result.stderr).toContain('rendererQueuedChars value "wat" is malformed')
    expect(result.stderr).toContain('no recognized budget metrics found')
  })

  it('ignores non-OpenCode annotations but fails when no perf rows remain', () => {
    const reportPath = writeReport('median=999.0ms', 'browser-unrelated')

    const result = runChecker(reportPath)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('No OpenCode terminal perf annotations found.')
  })
})
