import { beforeAll, describe, expect, it } from 'vitest'
import { classifyNodeServerChanges, collectNodeServerInputs } from './node-server-change-scope.mjs'
import { NODE_SERVER_RUNNERS, nodeServerQualification } from './node-server-qualification.mjs'
import { discoverUnitFiles } from './ci-unit-files.mjs'
import { planUnitSelection } from './ci-unit-selection.mjs'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

const policyTests = [
  'config/scripts/node-server-change-scope.test.mjs',
  'config/scripts/node-server-qualification.test.mjs'
]

const unavailableGraph = async () => {
  throw new Error('graph unavailable')
}

describe('modified Node-server policy self-tests', () => {
  let inputs
  let unitFiles
  beforeAll(async () => {
    inputs = await collectNodeServerInputs()
    unitFiles = discoverUnitFiles()
  }, 60_000)

  it.each(policyTests)(
    'keeps %s in required root units without native qualification',
    async (file) => {
      expect(classifyPrJobs([file], { allowMobileCiTools: true })).toMatchObject({
        test: true,
        static_analysis: true,
        typecheck: true,
        mobile_ci_tools: false
      })
      expect(inputs.has(file)).toBe(false)
      const scope = await classifyNodeServerChanges([file], async () => inputs, {
        modifiedFiles: [file]
      })
      expect(scope).toMatchObject({ shouldRun: false, graphResolved: true, matchedFiles: [] })
      const plan = planUnitSelection({
        files: unitFiles,
        changed: [file],
        graph: () => {
          throw new Error('config edits must select the full unit inventory')
        },
        timings: {},
        event: { pull_request: { draft: true } },
        mode: 'selected'
      })
      expect(plan.mode).toBe('shadow')
      expect(plan.executionFiles).toEqual(unitFiles)
      expect(plan.executionFiles).toContain(file)
    }
  )

  it('keeps both modified policy self-tests in root units', async () => {
    const scope = await classifyNodeServerChanges(policyTests, async () => inputs, {
      modifiedFiles: policyTests
    })
    expect(scope.shouldRun).toBe(false)
    expect(unitFiles).toEqual(expect.arrayContaining(policyTests))
  })

  it.each(policyTests)('requests the real graph before excluding %s', async (file) => {
    const scope = await classifyNodeServerChanges([file], unavailableGraph, {
      deferGraph: true,
      modifiedFiles: [file]
    })
    expect(scope.graphRequired).toBe(true)
    expect(scope.shouldRun).toBeUndefined()
  })

  it.each([
    { evidence: 'incomplete modified paths', changed: policyTests, modified: [policyTests[0]] },
    { evidence: 'missing modified paths', changed: policyTests },
    {
      evidence: 'duplicate modified paths',
      changed: policyTests,
      modified: [policyTests[0], policyTests[0]]
    },
    {
      evidence: 'foreign modified path',
      changed: policyTests,
      modified: [policyTests[0], 'config/scripts/foreign.test.mjs']
    },
    {
      evidence: 'unproven rename side',
      changed: [...policyTests, 'config/scripts/node-server-renamed.test.mjs'],
      modified: policyTests
    },
    {
      evidence: 'duplicate changed paths',
      changed: [policyTests[0], policyTests[0]],
      modified: policyTests
    }
  ])('retains full qualification with $evidence', async ({ changed, modified }) => {
    const scope = await classifyNodeServerChanges(changed, unavailableGraph, {
      modifiedFiles: modified
    })
    expect(scope.shouldRun).toBe(true)
    expect(scope.graphUnavailable).toBeUndefined()
    expect(nodeServerQualification(changed, scope)).toEqual({
      qualification: true,
      runners: NODE_SERVER_RUNNERS
    })
  })

  it.each([
    'config/scripts/node-server-change-scope.mjs',
    'config/scripts/node-server-qualification.mjs',
    'config/scripts/workspace-source-exports.test.mjs',
    '.github/workflows/node-server-tests.yml',
    '.github/actions/prepare-native-runtime/action.yml',
    'pnpm-lock.yaml'
  ])('keeps full qualification for mixed edits including %s', async (file) => {
    const changed = [...policyTests, file]
    const scope = await classifyNodeServerChanges(changed, unavailableGraph, {
      modifiedFiles: changed
    })
    expect(scope.shouldRun).toBe(true)
    expect(scope.graphUnavailable).toBeUndefined()
    expect(nodeServerQualification(changed, scope)).toEqual({
      qualification: true,
      runners: NODE_SERVER_RUNNERS
    })
  })

  it.each([
    'config/scripts/node-server-concurrency.test.mjs',
    'config/scripts/node-server-packaged-chat-selection.test.mjs'
  ])(
    'preserves unrelated %s routing with complete, absent, or non-modification evidence',
    async (file) => {
      expect(inputs.has(file)).toBe(false)
      for (const modifiedFiles of [[file], undefined, []]) {
        const scope = await classifyNodeServerChanges([file], async () => inputs, { modifiedFiles })
        expect(scope.shouldRun).toBe(false)
        expect(scope.graphUnavailable).toBeUndefined()
      }
    }
  )

  it.each([
    'config/scripts/node-server-concurrency.test.mjs',
    'config/scripts/node-server-packaged-chat-selection.test.mjs'
  ])('preserves both unmodified rename sides for unrelated %s', async (file) => {
    const changed = [file, file.replace('.test.mjs', '-renamed.test.mjs')]
    const scope = await classifyNodeServerChanges(changed, async () => inputs, {
      modifiedFiles: []
    })
    expect(scope.shouldRun).toBe(false)
    expect(scope.graphUnavailable).toBeUndefined()
  })

  it('preserves unrelated tests when only part of their changed vector is modified', async () => {
    const changed = [
      'config/scripts/node-server-concurrency.test.mjs',
      'config/scripts/node-server-packaged-chat-selection.test.mjs'
    ]
    const scope = await classifyNodeServerChanges(changed, async () => inputs, {
      modifiedFiles: [changed[0]]
    })
    expect(scope.shouldRun).toBe(false)
    expect(scope.graphUnavailable).toBeUndefined()
  })

  it.each(policyTests)(
    'retains native qualification when %s becomes a real graph input',
    async (file) => {
      const reachable = await collectNodeServerInputs({ entryPoints: [file] })
      expect(reachable.has(file)).toBe(true)
      const scope = await classifyNodeServerChanges([file], async () => reachable, {
        modifiedFiles: [file]
      })
      expect(scope).toMatchObject({ shouldRun: true, graphResolved: true, matchedFiles: [file] })
      expect(nodeServerQualification([file], scope)).toEqual({
        qualification: true,
        runners: NODE_SERVER_RUNNERS
      })
    }
  )

  it('retains full qualification when graph collection fails', async () => {
    const scope = await classifyNodeServerChanges(policyTests, unavailableGraph, {
      modifiedFiles: policyTests
    })
    expect(scope).toMatchObject({ shouldRun: true, graphUnavailable: true })
    expect(nodeServerQualification(policyTests, scope)).toEqual({
      qualification: true,
      runners: NODE_SERVER_RUNNERS
    })
  })
})
