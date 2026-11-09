import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareBenchmarkArtifacts } from './compare-benchmark-artifacts.mjs'

const scriptPath = 'config/scripts/performance/measurement/compare-benchmark-artifacts.mjs'
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
  it('rejects invalid benchmark artifacts before comparing partial metrics', () => {
    const dir = makeTempDir()
    const baselinePath = writeArtifact(dir, 'split-invalid.json', {
      label: 'invalid split',
      status: 'failed',
      valid: false,
      headlineMs: { shortcutToFocusP50: 0 }
    })
    const candidatePath = writeArtifact(dir, 'split-valid.json', {
      label: 'valid split',
      status: 'passed',
      valid: true,
      headlineMs: { shortcutToFocusP50: 10 }
    })

    expect(() => comparePaths(baselinePath, candidatePath)).toThrow(
      'split-invalid.json: benchmark artifact is marked invalid'
    )
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
})
