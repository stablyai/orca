import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { derivedGoldens } from './derived-goldens'
import { goldenRecording, type GoldenRecording } from './golden-recording'
import { MOUNTED_OPERATION_MODULES } from './adapters/mounted-operation-modules'
import { ADAPTER_DIRECTORY, RECORDER_DIRECTORY } from './recorder-digest'
import { readScenarios } from './scenario-input'
import type { MountedOperationModule } from './mounted-operation-module'
import type { RecordingScenario, ScenarioStep } from './recording-scenario'

/** Spelled, not imported: a rename of the excluded directory must fail this suite, not follow it. */
const MUTANT_DIRECTORY = `${RECORDER_DIRECTORY}/mutants`
const root = resolve(import.meta.dirname, '../../../..')
const manifest = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
).scenarios
const BASELINE = 'a'.repeat(40)
const EDITED_SCENARIO = 'b1'
const EDITED_SITE = 'files.searchPaths#1'
/** The only `legacy-inventory` scenario with a fulfilled reply at `EDITED_SITE`. */
const REPLAYED_SCENARIO = 'inventory-repeat-query'
const REPLAYED_GOLDEN = 'matrix-legacy-inventory-files.searchpaths-1'
/**
 * Every golden derived from `b1`: its own, and its family's four matrix sites, which expand from it
 * as the family's base. The two other `legacy-inventory` scenarios and the interruption and
 * lifecycle goldens that expand from `inventory-lifecycle` are deliberately absent.
 */
const EDITED_GOLDENS = [
  'b1',
  'matrix-legacy-inventory-files.searchpaths-1',
  'matrix-legacy-inventory-files.searchpaths-2',
  'matrix-legacy-inventory-fresh-inventory',
  'matrix-legacy-inventory-old-inventory'
]
type Header = Omit<GoldenRecording, 'recording'>

const created: string[] = []
afterAll(() => {
  for (const directory of created) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * One state of the recorder tree: the engine, the registered adapter modules, the source each one
 * holds, and the mutant evidence beside them. A module left out of `sources` gets identical stub
 * source, so only what a revision names is different between two of them.
 */
type Revision = {
  engine: string
  registered?: readonly MountedOperationModule[]
  sources?: Record<string, string>
  mutants?: Record<string, string>
}

/** The files a root contributes to a header, plus the manifest the oldest digest also read. */
function stubRoot(revision: Revision, scenarioFile: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'rpc-header-'))
  created.push(directory)
  mkdirSync(join(directory, ADAPTER_DIRECTORY), { recursive: true })
  writeFileSync(join(directory, RECORDER_DIRECTORY, 'runner.ts'), revision.engine)
  for (const { source } of revision.registered ?? MOUNTED_OPERATION_MODULES) {
    const stub = revision.sources?.[source] ?? 'export const adapter = 1'
    writeFileSync(join(directory, ADAPTER_DIRECTORY, source), stub)
  }
  mkdirSync(join(directory, MUTANT_DIRECTORY), { recursive: true })
  for (const [file, source] of Object.entries(revision.mutants ?? {})) {
    writeFileSync(join(directory, MUTANT_DIRECTORY, file), source)
  }
  writeFileSync(join(directory, 'mobile/pnpm-lock.yaml'), 'lockfile: stub\n')
  mkdirSync(join(directory, 'mobile/rpc-foundation'), { recursive: true })
  writeFileSync(join(directory, 'mobile/rpc-foundation/pilot-scenarios.json'), scenarioFile)
  return directory
}

/** Every golden's header for one recorder revision and one manifest, both written to a stub root. */
function headers(revision: Revision, scenarios: readonly RecordingScenario[]): Map<string, Header> {
  const stub = stubRoot(revision, JSON.stringify({ baseline: BASELINE, scenarios }))
  return new Map(
    derivedGoldens(scenarios).map((golden) => {
      const { recording: _recording, ...header } = goldenRecording(
        stub,
        BASELINE,
        golden.scenarios(),
        { scenario: golden.id, checkpoints: [] },
        revision.registered ?? MOUNTED_OPERATION_MODULES
      )
      return [golden.id, header]
    })
  )
}

function moved(before: Map<string, Header>, after: Map<string, Header>): string[] {
  return [...before]
    .filter(([id, header]) => JSON.stringify(after.get(id)) !== JSON.stringify(header))
    .map(([id]) => id)
    .sort()
}

const ADDED_MODULE: MountedOperationModule = {
  source: 'digest-probe-mount-adapters.ts',
  mounts: () => ({
    'digest.probe': () => {
      throw new Error('The digest reads adapter source; it never mounts one')
    }
  })
}

/** Every golden recorded through `new-tab-agent-mount-adapters.ts`, the module with one operation. */
const NEW_TAB_GOLDENS = [
  'matrix-settings-agent-read-preflight.detectremoteagents-1',
  'matrix-settings-agent-read-repo.list-1',
  'matrix-settings-agent-read-settings.get-1',
  'matrix-settings.new-tab-local-agents-preflight.detectagents-1',
  'matrix-settings.new-tab-local-agents-repo.list-1',
  'matrix-settings.new-tab-local-agents-settings.get-1',
  'new-tab-local-agents',
  'probe-new-tab-both-refused',
  'probe-new-tab-null-sibling-refused',
  'probe-new-tab-refused-sibling-rejects',
  'probe-new-tab-rejects-sibling-refused',
  'schedules-settings-new-tab-ssh',
  'settings-new-tab-refused',
  'settings-new-tab-ssh',
  'settings-new-tab-transport-error'
]

/** A family no other golden consumes, with one reply the matrix can replay as its success. */
const ADDED_FAMILY: RecordingScenario = {
  id: 'digest-probe',
  operation: 'digest.probe',
  version: 1,
  family: 'digest-probe',
  sites: [],
  schedules: ['probe'],
  steps: [
    {
      complete: 'probe.read#1',
      params: { worktree: 'id:A' },
      reply: { ok: true, result: { probed: true } }
    },
    { checkpoint: 'settled' }
  ]
}

type Completion = Extract<ScenarioStep, { complete: string }>

/** Rewrites one named completion, and fails loudly if the step it names has moved or multiplied. */
function editCompletion(
  scenarios: readonly RecordingScenario[],
  scenarioId: string,
  request: string,
  rewrite: (step: Completion) => Completion
): RecordingScenario[] {
  let edits = 0
  const edited = scenarios.map((scenario) =>
    scenario.id !== scenarioId
      ? scenario
      : {
          ...scenario,
          steps: scenario.steps.map((step) => {
            if (!('complete' in step) || step.complete !== request) {
              return step
            }
            edits++
            return rewrite(step)
          })
        }
  )
  if (edits !== 1) {
    throw new Error(`Expected one ${request} completion in ${scenarioId}, edited ${edits}`)
  }
  return edited
}

describe('golden header digests', () => {
  const ENGINE = 'export const runner = 1'

  // A whole domain PR: a family, the module that mounts it, and the mutant that proves its
  // projection load-bearing. None is an input to any other golden's header, so nothing already
  // recorded re-records and two such branches conflict on no golden line at all.
  it('re-digests nothing when a domain adds a family, an adapter module and a mutant', () => {
    const before = headers(
      { engine: ENGINE, mutants: { 'operation-mutations.ts': 'one' } },
      manifest
    )
    const after = headers(
      {
        engine: ENGINE,
        registered: [...MOUNTED_OPERATION_MODULES, ADDED_MODULE],
        mutants: { 'operation-mutations.ts': 'two', 'digest-probe-mutants.test.ts': 'added' }
      },
      [...manifest, ADDED_FAMILY]
    )
    expect(moved(before, after)).toEqual([])
    // The added family did derive goldens of its own: a pilot golden and one matrix site.
    expect(after.size).toBe(before.size + 2)
  })

  it('re-digests exactly the goldens recorded through an edited adapter module', () => {
    const before = headers({ engine: ENGINE }, manifest)
    const after = headers(
      {
        engine: ENGINE,
        sources: { 'new-tab-agent-mount-adapters.ts': 'export const adapter = 2' }
      },
      manifest
    )
    expect(moved(before, after)).toEqual([...NEW_TAB_GOLDENS].sort())
    for (const id of NEW_TAB_GOLDENS) {
      expect(after.get(id)?.recorderSha256).toBe(before.get(id)?.recorderSha256)
      expect(after.get(id)?.scenarioSha256).toBe(before.get(id)?.scenarioSha256)
      expect(after.get(id)?.adapterSha256).not.toBe(before.get(id)?.adapterSha256)
    }
  })

  it('re-digests exactly the goldens derived from an edited scenario', () => {
    const before = headers({ engine: ENGINE }, manifest)
    const after = headers(
      { engine: ENGINE },
      editCompletion(manifest, EDITED_SCENARIO, EDITED_SITE, (step) => ({
        ...step,
        params: { worktree: 'id:A', query: 'old', limit: 17 }
      }))
    )
    expect(moved(before, after)).toEqual([...EDITED_GOLDENS].sort())
    for (const id of EDITED_GOLDENS) {
      expect(after.get(id)?.recorderSha256).toBe(before.get(id)?.recorderSha256)
      expect(after.get(id)?.adapterSha256).toBe(before.get(id)?.adapterSha256)
      expect(after.get(id)?.scenarioSha256).not.toBe(before.get(id)?.scenarioSha256)
    }
  })

  // The generated variants are hashed, not the base they expand from, and this is what that buys:
  // the `normal` partition replays a sibling's recorded reply, so the sibling is a real input to a
  // matrix golden that its own scenario never appears in.
  it('re-digests a matrix golden whose replayed success comes from an edited sibling', () => {
    const before = headers({ engine: ENGINE }, manifest)
    const after = headers(
      { engine: ENGINE },
      editCompletion(manifest, REPLAYED_SCENARIO, EDITED_SITE, (step) => ({
        ...step,
        reply: { ok: true, result: { files: [{ relativePath: 'edited.ts' }] } }
      }))
    )
    expect(moved(before, after)).toEqual([REPLAYED_SCENARIO, REPLAYED_GOLDEN].sort())
  })

  it('re-digests every golden when an engine file changes', () => {
    const before = headers({ engine: ENGINE }, manifest)
    const after = headers({ engine: 'export const runner = 2' }, manifest)
    expect(moved(before, after)).toEqual([...before.keys()].sort())
    for (const [id, header] of before) {
      expect(after.get(id)?.recorderSha256).not.toBe(header.recorderSha256)
      expect(after.get(id)?.adapterSha256).toBe(header.adapterSha256)
      expect(after.get(id)?.scenarioSha256).toBe(header.scenarioSha256)
    }
  })
})
