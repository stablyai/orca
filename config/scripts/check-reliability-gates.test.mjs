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
  it('accepts the checked-in manifest', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(main(process.cwd())).resolves.toBe(0)
  })

  it('rejects soak gates without executable commands', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ commands: [] }))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Reliability gate manifest check failed')
    )
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('soak gates must declare at least one command')
    )
  })

  it('rejects soak gates without test files', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ testFiles: [] }))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('soak gates must declare at least one test file')
    )
  })

  it('rejects command-backed gates that select tests by title', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({ maturity: 'experimental', commands: ['pnpm vitest -t flaky-title'] })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('commands must not rely on title selectors')
    )
  })

  it('rejects gates without a protection level', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const manifest = JSON.parse(validManifest())
    delete manifest.gates[0].protection
    const root = makeTempRoot(JSON.stringify(manifest, null, 2))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection must be one of none, partial, or active')
    )
  })

  it('rejects commandless gates unless they declare protection none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        protection: 'partial',
        commands: [],
        testFiles: [],
        flakeHistory: { status: 'not-started', evidence: 'Planning entry only.' },
        redGreenEvidence: { status: 'missing', evidence: 'No executable proof yet.' }
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('commandless gates must declare protection none')
    )
  })

  it('rejects command-backed gates marked as no protection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ maturity: 'experimental', protection: 'none' }))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection none gates must not declare commands or testFiles')
    )
  })

  it('reserves active protection for stable blocking gates', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ maturity: 'experimental', protection: 'active' }))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection active is reserved for blocking gates')
    )
  })

  it('rejects partial gates without a passed evidence run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ maturity: 'experimental', evidenceRuns: [] }))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection partial gates need a passed evidence run')
    )
  })

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

  it('rejects protection none gates with evidence runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        protection: 'none',
        commands: [],
        testFiles: [],
        flakeHistory: { status: 'not-started', evidence: 'Planning entry only.' },
        redGreenEvidence: { status: 'missing', evidence: 'No executable proof yet.' }
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection none gates must not declare evidenceRuns')
    )
  })

  it('rejects partial gates without assertion refs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ maturity: 'experimental', assertionRefs: [] }))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection partial gates need assertionRefs')
    )
  })

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

  it('rejects protection none gates with assertion refs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        protection: 'none',
        commands: [],
        testFiles: [],
        evidenceRuns: [],
        assertionRefs: [
          {
            file: 'some.test.ts',
            assertions: ['planning entry must not look tested']
          }
        ],
        coveredPlatforms: [],
        coveredProviders: [],
        flakeHistory: { status: 'not-started', evidence: 'Planning entry only.' },
        redGreenEvidence: { status: 'missing', evidence: 'No executable proof yet.' }
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection none gates must not declare assertionRefs')
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

  it('requires coveredPlatforms to include passed evidence platforms', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        coveredPlatforms: ['linux']
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('coveredPlatforms must include passed evidence platform macos')
    )
  })

  it('rejects covered scope on protection none gates', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        protection: 'none',
        commands: [],
        testFiles: [],
        evidenceRuns: [],
        coveredPlatforms: ['macos'],
        coveredProviders: [],
        flakeHistory: { status: 'not-started', evidence: 'Planning entry only.' },
        redGreenEvidence: { status: 'missing', evidence: 'No executable proof yet.' }
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection none gates must not declare covered scope')
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

  it('rejects soak gates without mature flake and red/green evidence', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        flakeHistory: { status: 'unknown', evidence: 'No soak yet.' },
        redGreenEvidence: { status: 'partial', evidence: 'No saved artifact yet.' }
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('soak gates must have soaking or stable flakeHistory')
    )
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('soak gates must have complete red/green evidence')
    )
  })

  it('rejects malformed JSONC', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot('{ "schemaVersion": 1, } trailing')

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('JSONC parse error'))
  })

  it('rejects missing manifests with a structured error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = mkdtempSync(path.join(tmpdir(), 'orca-reliability-gates-'))
    tempDirs.push(root)

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unable to read manifest'))
  })

  it('uses policy maturity levels as the source of truth', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const manifest = JSON.parse(validManifest())
    manifest.policy.maturityLevels = ['experimental']
    const root = makeTempRoot(JSON.stringify(manifest, null, 2))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('maturity is invalid'))
  })

  it('rejects malformed blocking promotion policy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const manifest = JSON.parse(validManifest())
    manifest.policy.blockingPromotion.maximumUnexplainedFlakes = -1
    const root = makeTempRoot(JSON.stringify(manifest, null, 2))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'policy.blockingPromotion.maximumUnexplainedFlakes must be a non-negative number'
      )
    )
  })
})
