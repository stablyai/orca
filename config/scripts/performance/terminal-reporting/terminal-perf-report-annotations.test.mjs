import { describe, expect, it } from 'vitest'
import { collectTerminalPerfRows } from './terminal-perf-report-annotations.mjs'

describe('terminal perf report annotations', () => {
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
})
