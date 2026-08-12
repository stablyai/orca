import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  generateTerminalPerfHtmlReport,
  parseHtmlReportArgs
} from './generate-terminal-perf-html-report.mjs'

const tempDirs = []

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-terminal-perf-html-'))
  tempDirs.push(dir)
  return dir
}

function writeReport(
  annotationDescription,
  annotationType = 'opencode-scale-same-workspace-25',
  reportName = 'report.json'
) {
  const dir = makeTempDir()
  const reportPath = join(dir, reportName)
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
                    },
                    {
                      type: 'browser-unrelated',
                      description: 'median=999.0ms'
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

describe('generate-terminal-perf-html-report', () => {
  it('parses labeled and bare input paths plus output flags', () => {
    expect(parseHtmlReportArgs(['--', 'a.json', 'b.json', '--output', 'out.html'])).toEqual({
      inputs: [
        { label: 'a', path: 'a.json' },
        { label: 'b', path: 'b.json' }
      ],
      outputPath: 'out.html'
    })
    expect(parseHtmlReportArgs(['main=runs/0-main.json', '#5038 final=runs/4-final.json'])).toEqual(
      {
        inputs: [
          { label: 'main', path: 'runs/0-main.json' },
          { label: '#5038 final', path: 'runs/4-final.json' }
        ],
        outputPath: 'test-results/terminal-perf-impact-report.html'
      }
    )
    expect(
      parseHtmlReportArgs(['a.json'], { ORCA_E2E_TERMINAL_PERF_HTML_REPORT_PATH: 'env.html' })
    ).toEqual({
      inputs: [{ label: 'a', path: 'a.json' }],
      outputPath: 'env.html'
    })
    expect(() => parseHtmlReportArgs(['--output'])).toThrow('--output requires a path')
    expect(() => parseHtmlReportArgs([])).toThrow('Usage:')
  })

  it('writes a single-run report with scenario tables and budget status', () => {
    const reportPath = writeReport(
      [
        'panes=25',
        'frames=60',
        'median=12.4ms',
        'worst=44.8ms',
        'revisit=28.6ms',
        'scroll=61.0ms',
        'restore=320.0ms',
        'maxTimerDrift=8.0ms',
        'rendererPeakQueuedChars=2048',
        'mainPeakInFlightChars=4096',
        'heldAckChars=1024',
        'hiddenSkippedChars=512',
        'rendererDroppedBacklogs=0'
      ].join(' ')
    )
    const outputPath = join(makeTempDir(), 'report.html')

    const result = generateTerminalPerfHtmlReport({
      inputPaths: [reportPath],
      outputPath,
      now: new Date('2026-06-09T10:00:00.000Z')
    })

    const html = readFileSync(outputPath, 'utf8')
    expect(result).toEqual({ budgetFailureCount: 0, outputPath, rowCount: 1 })
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Terminal Performance Over Time')
    expect(html).toContain('2026-06-09T10:00:00.000Z')
    expect(html).toContain('Same workspace panes — 25 panes')
    expect(html).toContain('opencode-scale-same-workspace-25')
    expect(html).toContain('28.6ms')
    expect(html).toContain('Pass')
    // Why: one run has no over-time story; the trend section must not render.
    expect(html).not.toContain('Trends across revisions')
    expect(html).not.toContain('browser-unrelated')
  })

  it('renders parked-memory heap and live view counts as table metrics', () => {
    const reportPath = writeReport(
      'panes=8 parkedTabs=8 heapUsedMB=142.5 liveTerminals=1 livePaneManagers=1',
      'opencode-parked-memory'
    )
    const outputPath = join(makeTempDir(), 'report.html')

    const result = generateTerminalPerfHtmlReport({ inputPaths: [reportPath], outputPath })

    const html = readFileSync(outputPath, 'utf8')
    // Why: heapUsedMB has no budget — a memory row alone must not fail gates.
    expect(result.budgetFailureCount).toBe(0)
    expect(html).toContain('Parked hidden terminal memory — 8 panes')
    expect(html).toContain('Renderer JS heap (MB)')
    expect(html).toContain('142.5')
    expect(html).toContain('Live xterm instances')
    expect(html).toContain('Live pane managers')
  })

  it('marks over-budget rows as failures for the latest run', () => {
    const reportPath = writeReport(
      [
        'panes=100',
        'median=80.0ms',
        'worst=301.0ms',
        'revisit=301.0ms',
        'rendererPeakQueuedChars=2097153',
        'rendererDroppedBacklogs=1'
      ].join(' '),
      'opencode-scale-cross-workspace-100'
    )
    const outputPath = join(makeTempDir(), 'report.html')

    const result = generateTerminalPerfHtmlReport({ inputPaths: [reportPath], outputPath })

    const html = readFileSync(outputPath, 'utf8')
    expect(result.budgetFailureCount).toBe(5)
    expect(html).toContain('Fail')
    expect(html).toContain('medianMs 80 &gt; 75')
    expect(html).toContain('Cross-workspace hidden panes')
  })

  it('renders ordered revisions with trend charts and baseline deltas', () => {
    const mainReport = writeReport(
      'panes=25 median=50.0ms worst=120.0ms rendererDroppedBacklogs=0',
      'opencode-scale-same-workspace-25',
      'main.json'
    )
    const middleReport = writeReport(
      'panes=25 median=30.0ms worst=140.0ms rendererDroppedBacklogs=0',
      'opencode-scale-same-workspace-25',
      'backpressure.json'
    )
    const finalReport = writeReport(
      'panes=25 median=20.0ms worst=100.0ms rendererDroppedBacklogs=0',
      'opencode-scale-same-workspace-25',
      'final.json'
    )
    const outputPath = join(makeTempDir(), 'report.html')

    const result = generateTerminalPerfHtmlReport({
      inputs: [
        { label: 'main', path: mainReport },
        { label: 'backpressure', path: middleReport },
        { label: 'final', path: finalReport }
      ],
      outputPath
    })

    const html = readFileSync(outputPath, 'utf8')
    expect(result.rowCount).toBe(3)
    expect(html).toContain('Baseline vs latest')
    expect(html).toContain('Trends across revisions')
    expect(html).toContain('trend-chart')
    expect(html).toContain('>main<')
    expect(html).toContain('>backpressure<')
    expect(html).toContain('>final<')
    // Why: median 50 -> 20 is a 60% improvement and must read as better.
    expect(html).toContain('delta better')
    expect(html).toContain('-60%')
    expect(html).toContain('50.0ms → 20.0ms')
  })

  it('renders missing scenarios at older revisions as gaps, not zeros', () => {
    const mainReport = writeReport(
      'panes=25 median=50.0ms rendererDroppedBacklogs=0',
      'opencode-scale-same-workspace-25',
      'main.json'
    )
    const finalReport = makeTempDir()
    const finalPath = join(finalReport, 'final.json')
    writeFileSync(
      finalPath,
      JSON.stringify({
        suites: [
          {
            specs: [
              {
                tests: [
                  {
                    annotations: [
                      {
                        type: 'opencode-scale-same-workspace-25',
                        description: 'panes=25 median=40.0ms rendererDroppedBacklogs=0'
                      },
                      {
                        type: 'opencode-revisit-pressure',
                        description: 'panes=19 median=3.0ms revisit=4.4ms rendererDroppedBacklogs=0'
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
    const outputPath = join(makeTempDir(), 'report.html')

    generateTerminalPerfHtmlReport({
      inputs: [
        { label: 'main', path: mainReport },
        { label: 'final', path: finalPath }
      ],
      outputPath
    })

    const html = readFileSync(outputPath, 'utf8')
    expect(html).toContain('Revisit under pressure')
    expect(html).toContain('<td>—</td>')
  })

  it('fails when reports contain no terminal perf annotations', () => {
    const reportPath = writeReport('median=12.0ms', 'browser-unrelated')

    expect(() =>
      generateTerminalPerfHtmlReport({
        inputPaths: [reportPath],
        outputPath: join(makeTempDir(), 'report.html')
      })
    ).toThrow('No opencode terminal perf annotations found')
  })
})
