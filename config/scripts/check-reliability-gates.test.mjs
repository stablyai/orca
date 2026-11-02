import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from './check-reliability-gates.mjs'

const tempDirs = []

function makeTempRoot(manifest) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-reliability-gates-'))
  tempDirs.push(root)
  const configDir = path.join(root, 'config')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(path.join(configDir, 'reliability-gates.jsonc'), manifest, 'utf8')
  writeFileSync(path.join(root, 'some.test.ts'), '', 'utf8')
  return root
}

function validManifest(overrides = {}) {
  return JSON.stringify(
    {
      schemaVersion: 1,
      policy: {
        maturityLevels: ['experimental', 'soak', 'blocking', 'accepted-gap', 'deprecated'],
        blockingPromotion: {
          minimumSoakRuns: 100,
          minimumSoakDays: 14,
          maximumUnexplainedFlakes: 0
        }
      },
      gates: [
        {
          id: 'terminal-session.snapshot-freshness',
          title: 'Stale liveness snapshots cannot close newer PTY bindings',
          maturity: 'soak',
          protection: 'partial',
          owner: 'terminal-runtime',
          layer: 'renderer-unit',
          surfaces: ['terminal lifecycle'],
          platforms: ['macos', 'linux', 'windows'],
          providers: ['local', 'daemon'],
          coveredPlatforms: ['macos'],
          coveredProviders: ['local'],
          coverageNotes: 'One local macOS unit run covers the local decision-layer fixture only.',
          motivatingLinks: ['https://github.com/stablyai/orca/issues/6773'],
          invariant: 'A stale snapshot cannot close a newer binding.',
          oracle: 'The test rejects reconciliation when the binding is newer than the snapshot.',
          commands: ['pnpm exec vitest run some.test.ts'],
          testFiles: ['some.test.ts'],
          assertionRefs: [
            {
              file: 'some.test.ts',
              assertions: ['stale liveness snapshots do not close newer PTY bindings']
            }
          ],
          evidenceRuns: [
            {
              date: '2026-07-02',
              runner: 'local',
              platform: 'macos',
              command: 'pnpm exec vitest run some.test.ts',
              result: 'passed',
              durationSeconds: 1.2,
              summary: '1 file passed.'
            }
          ],
          runtimeBudget: {
            p95Seconds: 10,
            scope: 'local unit test'
          },
          flakeHistory: {
            status: 'soaking',
            evidence: 'Soak history exists.'
          },
          redGreenEvidence: {
            status: 'complete',
            evidence: 'Fails when the guard is removed and passes with the fix.'
          },
          performanceBudget: {
            required: true,
            evidence: 'Perf measurement is required before blocking promotion.'
          },
          promotionCriteria: ['Collect soak history.'],
          knownGaps: ['Needs an Electron survival test.'],
          demotionRule: 'Demote on unexplained flakes.',
          ...overrides
        }
      ]
    },
    null,
    2
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('check-reliability-gates', () => {
  it('rejects evidence runs whose command is not declared by the gate', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        evidenceRuns: [
          {
            date: '2026-07-02',
            runner: 'local',
            platform: 'macos',
            command: 'pnpm exec vitest run other.test.ts',
            result: 'passed',
            durationSeconds: 1,
            summary: 'Wrong command.'
          }
        ]
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('evidenceRuns[0].command must match one of the gate commands')
    )
  })

  it('preserves the executed command when evidence links to a renamed gate command', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const manifest = JSON.parse(validManifest())
    manifest.gates[0].evidenceRuns[0].command = 'pnpm exec vitest run old-name.test.ts'
    manifest.gates[0].evidenceRuns[0].currentCommand = manifest.gates[0].commands[0]
    const root = makeTempRoot(JSON.stringify(manifest))

    await expect(main(root)).resolves.toBe(0)
  })

  it.each(['', null, 42, 'pnpm exec vitest run unrelated.test.ts'])(
    'rejects an invalid current command link: %s',
    async (currentCommand) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const manifest = JSON.parse(validManifest())
      manifest.gates[0].evidenceRuns[0].currentCommand = currentCommand
      const root = makeTempRoot(JSON.stringify(manifest))

      await expect(main(root)).resolves.toBe(1)
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('evidenceRuns[0].currentCommand')
      )
    }
  )

  it.each(['', null, 42])(
    'requires the executed command even when a current command link exists: %s',
    async (command) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const manifest = JSON.parse(validManifest())
      manifest.gates[0].evidenceRuns[0].command = command
      manifest.gates[0].evidenceRuns[0].currentCommand = manifest.gates[0].commands[0]
      const root = makeTempRoot(JSON.stringify(manifest))

      await expect(main(root)).resolves.toBe(1)
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('evidenceRuns[0].command must be a non-empty string')
      )
    }
  )

  it('rejects assertion refs outside declared test files', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        assertionRefs: [
          {
            file: 'other.test.ts',
            assertions: ['important invariant']
          }
        ]
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('assertionRefs[0].file must be one of the gate testFiles')
    )
  })

  it('rejects covered scope outside the risk scope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        coveredPlatforms: ['ios'],
        coveredProviders: ['ssh']
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('covered platform is outside risk scope: ios')
    )
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('covered provider is outside risk scope: ssh')
    )
  })

  it('rejects declared test files that do not exist', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({ maturity: 'experimental', testFiles: ['missing.test.ts'] })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('test file does not exist: missing.test.ts')
    )
  })

  it('rejects executable gates whose commands do not reference declared test files', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const command = 'pnpm exec vitest run'
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        commands: [command],
        evidenceRuns: [
          {
            date: '2026-07-02',
            runner: 'local',
            platform: 'macos',
            command,
            result: 'passed',
            durationSeconds: 1,
            summary: 'Command did not name the declared file.'
          }
        ]
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('test file is not referenced by any gate command: some.test.ts')
    )
  })
})
