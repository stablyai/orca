import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = 'config/scripts/summarize-terminal-perf-report.mjs'
const tempDirs = []

function writeReport() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-terminal-perf-summary-'))
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
                      type: 'opencode-scale',
                      description: 'panes=50 frames=60 median=12.3ms rendererQueuedChars=1000'
                    },
                    {
                      type: 'browser-unrelated',
                      description: 'panes=1 median=999.0ms'
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

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('summarize-terminal-perf-report', () => {
  it('prints only OpenCode terminal perf annotation rows', () => {
    const output = execFileSync(process.execPath, [scriptPath, writeReport()], {
      cwd: process.cwd(),
      encoding: 'utf8'
    })

    expect(output).toContain('| Source | Scenario | Panes | Frames | Median |')
    expect(output).toContain('| report.json | opencode-scale | 50 | 60 | 12.3ms |')
    expect(output).toContain('1000')
    expect(output).not.toContain('browser-unrelated')
    expect(output).not.toContain('999.0ms')
  })
})
