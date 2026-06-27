import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectTerminalPerfRows,
  parseAnnotationDescription,
  readJsonReport
} from './terminal-perf-report-annotations.mjs'

const tempDirs = []

function makeReportPath(content) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-terminal-perf-annotations-'))
  tempDirs.push(dir)
  const reportPath = join(dir, 'report.json')
  writeFileSync(reportPath, content)
  return reportPath
}

function makeNestedReport() {
  return {
    suites: [
      {
        specs: [
          {
            tests: [
              {
                annotations: [
                  {
                    type: 'browser-unrelated',
                    description: 'median=999.0ms'
                  }
                ]
              }
            ]
          }
        ],
        suites: [
          {
            specs: [
              {
                tests: [
                  {
                    annotations: [
                      {
                        type: 'opencode-scale',
                        description: 'panes=50 median=12.3ms ignored-token rendererQueuedChars=1000'
                      },
                      {
                        type: 'terminal-scale',
                        description: 'panes=25 median=7.0ms'
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('terminal perf report annotations', () => {
  it('parses key-value annotation description segments only', () => {
    expect(parseAnnotationDescription('panes=50 no-equals median=12.3ms name=a=b')).toEqual({
      median: '12.3ms',
      name: 'a=b',
      panes: '50'
    })
  })

  it('reads JSON reports surrounded by noisy process output', () => {
    const reportPath = makeReportPath(
      `noise before\n${JSON.stringify({ suites: [] })}\nnoise after`
    )

    expect(readJsonReport(reportPath)).toEqual({ suites: [] })
  })

  it('collects nested OpenCode annotations by default', () => {
    expect(collectTerminalPerfRows(makeNestedReport(), 'report.json')).toEqual([
      {
        median: '12.3ms',
        panes: '50',
        rendererQueuedChars: '1000',
        scenario: 'opencode-scale',
        source: 'report.json'
      }
    ])
  })

  it('keeps trusted source and scenario fields when descriptions contain matching keys', () => {
    const report = {
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  annotations: [
                    {
                      type: 'opencode-scale',
                      description: 'source=spoofed.json scenario=spoofed median=12.3ms'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }

    expect(collectTerminalPerfRows(report, 'report.json')).toEqual([
      {
        median: '12.3ms',
        scenario: 'opencode-scale',
        source: 'report.json'
      }
    ])
  })

  it('supports a custom annotation type prefix', () => {
    expect(
      collectTerminalPerfRows(makeNestedReport(), 'report.json', { typePrefix: 'terminal-' })
    ).toEqual([
      {
        median: '7.0ms',
        panes: '25',
        scenario: 'terminal-scale',
        source: 'report.json'
      }
    ])
  })
})
