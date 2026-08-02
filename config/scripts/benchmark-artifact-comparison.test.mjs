import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compareBenchmarkArtifacts,
  formatBenchmarkComparisonMarkdown,
  parseBenchmarkComparisonArgs
} from './compare-benchmark-artifacts.mjs'

const scriptPath = 'config/scripts/compare-benchmark-artifacts.mjs'
const tempDirs = []

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-benchmark-comparison-'))
  tempDirs.push(dir)
  return dir
}

function writeArtifact(dir, name, artifact) {
  const artifactPath = join(dir, name)
  writeFileSync(artifactPath, JSON.stringify(artifact))
  return artifactPath
}

function comparePaths(baselinePath, candidatePath, extra = {}) {
  return compareBenchmarkArtifacts({
    baselinePath,
    candidatePath,
    now: () => new Date('2026-06-21T12:00:00.000Z'),
    title: 'Test Compare',
    ...extra
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('benchmark artifact comparison', () => {
  it('parses required CLI flags and rejects missing paths', () => {
    expect(() => parseBenchmarkComparisonArgs(['--baseline'])).toThrow('--baseline requires a path')
    expect(() => parseBenchmarkComparisonArgs(['--candidate'])).toThrow(
      '--candidate requires a path'
    )
    expect(() => parseBenchmarkComparisonArgs(['--candidate', 'candidate.json'])).toThrow(
      'Usage: node config/scripts/compare-benchmark-artifacts.mjs --baseline <path> --candidate <path> [--title <title>] [--output <path>] [--json-output <path>] [--higher-is-better <metric-key> ...]'
    )
  })

  it('compares startup-style summary median metrics and skips null candidates', () => {
    const dir = makeTempDir()
    const baselinePath = writeArtifact(dir, 'baseline.json', {
      label: 'baseline',
      summaryMedianMs: {
        missingLater: 5,
        spawnToAppReady: 25,
        totalToDidFinishLoad: 100
      }
    })
    const candidatePath = writeArtifact(dir, 'candidate.json', {
      label: 'candidate',
      summaryMedianMs: {
        missingLater: null,
        spawnToAppReady: 30,
        totalToDidFinishLoad: 40
      }
    })

    const comparison = comparePaths(baselinePath, candidatePath)

    expect(comparison.schemaVersion).toBe(1)
    expect(comparison.createdAt).toBe('2026-06-21T12:00:00.000Z')
    expect(comparison.baseline.label).toBe('baseline')
    expect(comparison.candidate.label).toBe('candidate')
    expect(
      comparison.metrics.find((metric) => metric.key === 'totalToDidFinishLoad')
    ).toMatchObject({
      absoluteDelta: -60,
      baseline: 100,
      candidate: 40,
      percentDelta: -60,
      status: 'improved',
      unit: 'ms'
    })
    expect(comparison.metrics.find((metric) => metric.key === 'spawnToAppReady')).toMatchObject({
      status: 'regressed'
    })
    expect(comparison.skippedMetrics).toContainEqual({
      key: 'missingLater',
      reason: 'missing candidate metric'
    })
  })

  it('compares numeric Playwright annotation metrics and omits metadata fields', () => {
    const dir = makeTempDir()
    const baselinePath = writeArtifact(dir, 'baseline-playwright.json', {
      suites: [
        {
          suites: [
            {
              specs: [
                {
                  tests: [
                    {
                      annotations: [
                        {
                          type: 'opencode-scale-same-workspace-50',
                          description:
                            'panes=50 frames=60 median=80.0ms worst=120.0ms rendererQueuedChars=1000 samples=1,2'
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
    })
    const candidatePath = writeArtifact(dir, 'candidate-playwright.json', {
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  annotations: [
                    {
                      type: 'opencode-scale-same-workspace-50',
                      description:
                        'panes=50 frames=60 median=60.0ms worst=100.0ms rendererQueuedChars=800 samples=1,2'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })

    const comparison = comparePaths(baselinePath, candidatePath)
    const metricKeys = comparison.metrics.map((metric) => metric.key)

    expect(metricKeys).toContain('opencode-scale-same-workspace-50.median')
    expect(metricKeys).toContain('opencode-scale-same-workspace-50.rendererQueuedChars')
    expect(metricKeys).not.toContain('opencode-scale-same-workspace-50.panes')
    expect(metricKeys).not.toContain('opencode-scale-same-workspace-50.frames')
    expect(metricKeys).not.toContain('opencode-scale-same-workspace-50.samples')
    expect(
      comparison.metrics.find((metric) => metric.key === 'opencode-scale-same-workspace-50.median')
    ).toMatchObject({ status: 'improved', unit: 'ms' })
  })

  it('aggregates duplicate Playwright scenario metrics before comparison', () => {
    const dir = makeTempDir()
    const baselinePath = writeArtifact(dir, 'baseline-playwright-duplicates.json', {
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  annotations: [
                    {
                      type: 'opencode-duplicate',
                      description: 'median=80.0ms rendererQueuedChars=1000'
                    },
                    {
                      type: 'opencode-duplicate',
                      description: 'median=100.0ms rendererQueuedChars=1400'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })
    const candidatePath = writeArtifact(dir, 'candidate-playwright-duplicates.json', {
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  annotations: [
                    {
                      type: 'opencode-duplicate',
                      description: 'median=60.0ms rendererQueuedChars=800'
                    },
                    {
                      type: 'opencode-duplicate',
                      description: 'median=70.0ms rendererQueuedChars=1000'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })

    const comparison = comparePaths(baselinePath, candidatePath)
    const duplicateMedianMetrics = comparison.metrics.filter(
      (metric) => metric.key === 'opencode-duplicate.median'
    )

    expect(duplicateMedianMetrics).toHaveLength(1)
    expect(duplicateMedianMetrics[0]).toMatchObject({
      absoluteDelta: -25,
      baseline: 90,
      candidate: 65,
      percentDelta: -27.8,
      status: 'improved',
      unit: 'ms'
    })
    expect(
      comparison.metrics.filter((metric) => metric.key === 'opencode-duplicate.rendererQueuedChars')
    ).toHaveLength(1)
  })

  it('skips unit mismatches instead of comparing incompatible metrics', () => {
    const dir = makeTempDir()
    const baselinePath = writeArtifact(dir, 'baseline-playwright-units.json', {
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  annotations: [
                    {
                      type: 'opencode-units',
                      description: 'median=80.0ms rendererQueuedChars=1000'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })
    const candidatePath = writeArtifact(dir, 'candidate-playwright-units.json', {
      suites: [
        {
          specs: [
            {
              tests: [
                {
                  annotations: [
                    {
                      type: 'opencode-units',
                      description: 'median=60 rendererQueuedChars=800'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })

    const comparison = comparePaths(baselinePath, candidatePath)

    expect(comparison.metrics.map((metric) => metric.key)).toEqual([
      'opencode-units.rendererQueuedChars'
    ])
    expect(comparison.skippedMetrics).toContainEqual({
      key: 'opencode-units.median',
      reason: 'unit mismatch (ms vs count)'
    })
  })

  it('supports higher-is-better metrics for generic summary artifacts', () => {
    const dir = makeTempDir()
    const baselinePath = writeArtifact(dir, 'generic-baseline.json', {
      summary: {
        totalBytes: 2048,
        totalCpuPercent: { mean: 80 },
        throughput: 10
      }
    })
    const candidatePath = writeArtifact(dir, 'generic-candidate.json', {
      summary: {
        totalBytes: 1024,
        totalCpuPercent: { mean: 70 },
        throughput: 12
      }
    })

    const comparison = comparePaths(baselinePath, candidatePath, {
      higherIsBetter: new Set(['summary.throughput'])
    })

    expect(comparison.metrics.find((metric) => metric.key === 'summary.throughput')).toMatchObject({
      direction: 'higher-is-better',
      status: 'improved'
    })
    expect(comparison.metrics.find((metric) => metric.key === 'summary.totalBytes')).toMatchObject({
      unit: 'bytes'
    })
    expect(
      comparison.metrics.find((metric) => metric.key === 'summary.totalCpuPercent.mean')
    ).toMatchObject({
      unit: '%'
    })
  })

  it('writes Markdown and JSON reports from the CLI while printing Markdown', () => {
    const dir = makeTempDir()
    const baselinePath = writeArtifact(dir, 'baseline.json', {
      label: 'baseline',
      summaryMedianMs: { totalToDidFinishLoad: 100 }
    })
    const candidatePath = writeArtifact(dir, 'candidate.json', {
      label: 'candidate',
      summaryMedianMs: { totalToDidFinishLoad: 40 }
    })
    const markdownPath = join(dir, 'nested', 'comparison.md')
    const jsonPath = join(dir, 'nested', 'comparison.json')

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--baseline',
        baselinePath,
        '--candidate',
        candidatePath,
        '--title',
        'Test Compare',
        '--output',
        markdownPath,
        '--json-output',
        jsonPath
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('| Metric | Baseline | Candidate | Delta | Delta % | Result |')
    expect(result.stdout).toContain(
      '| totalToDidFinishLoad | 100.0ms | 40.0ms | -60.0ms | -60.0% | improved |'
    )
    expect(existsSync(markdownPath)).toBe(true)
    expect(existsSync(jsonPath)).toBe(true)
    expect(JSON.parse(readFileSync(jsonPath, 'utf8')).schemaVersion).toBe(1)
  })

  it('redacts absolute input paths from generated reports', () => {
    const dir = makeTempDir()
    const baselinePath = writeArtifact(dir, 'absolute-baseline.json', {
      label: 'baseline',
      summaryMedianMs: { totalToDidFinishLoad: 100 }
    })
    const candidatePath = writeArtifact(dir, 'absolute-candidate.json', {
      label: 'candidate',
      summaryMedianMs: { totalToDidFinishLoad: 40 }
    })
    const markdownPath = join(dir, 'comparison.md')
    const jsonPath = join(dir, 'comparison.json')

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--baseline',
        baselinePath,
        '--candidate',
        candidatePath,
        '--output',
        markdownPath,
        '--json-output',
        jsonPath
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    const json = JSON.parse(readFileSync(jsonPath, 'utf8'))
    const markdown = readFileSync(markdownPath, 'utf8')

    expect(result.status).toBe(0)
    expect(json.baseline.path).toBe('absolute-baseline.json')
    expect(json.candidate.path).toBe('absolute-candidate.json')
    expect(markdown).not.toContain(dir)
    expect(result.stdout).not.toContain(dir)
  })

  it('escapes artifact-controlled Markdown fields in reports', () => {
    const markdown = formatBenchmarkComparisonMarkdown({
      title: 'Compare\n[Injected](https://example.test)',
      createdAt: '2026-06-21T12:00:00.000Z',
      baseline: { label: 'base\n<label>', path: 'base|path', kind: 'summary' },
      candidate: { label: 'candidate', path: 'candidate.md', kind: 'summary' },
      metrics: [
        {
          key: 'summary.value|with-pipe',
          unit: '',
          baseline: 1,
          candidate: 2,
          absoluteDelta: 1,
          percentDelta: 100,
          status: 'regressed'
        }
      ],
      skippedMetrics: [{ key: 'missing\nmetric', reason: 'missing | candidate' }]
    })

    expect(markdown).toContain('# Compare \\[Injected\\]\\(https://example\\.test\\)')
    expect(markdown).toContain('Baseline: base \\<label\\> (base|path)')
    expect(markdown).toContain(
      '| summary\\.value\\|with\\-pipe | 1.0 | 2.0 | 1.0 | 100.0% | regressed |'
    )
    expect(markdown).toContain('- missing metric: missing | candidate')
  })

  it('fails unsupported artifacts in the CLI', () => {
    const dir = makeTempDir()
    const baselinePath = writeArtifact(dir, 'baseline.json', { hello: 'world' })
    const candidatePath = writeArtifact(dir, 'candidate.json', { hello: 'world' })

    const result = spawnSync(
      process.execPath,
      [scriptPath, '--baseline', baselinePath, '--candidate', candidatePath],
      { cwd: process.cwd(), encoding: 'utf8' }
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unsupported benchmark artifact')
  })
})
