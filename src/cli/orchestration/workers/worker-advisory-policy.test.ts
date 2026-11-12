import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../../runtime/client'
import { ORCHESTRATION_HANDLERS } from '../orchestration-handlers'
import { okFixture } from '../../runtime/fixtures/runtime-rpc-fixtures'

const scratch: string[] = []
const policy = {
  schema: 1,
  dataScope: 'published',
  sourcePin: 'a'.repeat(40),
  deadlineAt: 1_800_000_300_000,
  maxModelCalls: 4,
  artifacts: [
    {
      path: 'note.txt',
      text: 'hello',
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    }
  ]
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
  process.exitCode = undefined
})

async function invoke(
  raw: string,
  advisorySupported: boolean,
  kind: 'advisory' | 'execution' = 'advisory'
) {
  const dir = await mkdtemp(join(tmpdir(), 'orca-advisory-cli-'))
  scratch.push(dir)
  await writeFile(join(dir, 'policy.json'), raw)
  const client = new RuntimeClient(dir, 60_000, null, null)
  const mutations: unknown[] = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'status.get') {
      return okFixture('status', {
        capabilities: [
          'orchestration.worker-launch-preferences.v1',
          ...(advisorySupported ? [`orchestration.worker-${kind}-policy.v1`] : [])
        ]
      })
    }
    if (method !== 'orchestration.workerStart') {
      throw new Error('Unexpected RPC.')
    }
    mutations.push(params)
    return okFixture('start', {
      state: 'ready',
      taskId: 'consult',
      dispatchId: 'advisor',
      effects: [],
      residualResources: []
    })
  })
  const run = () =>
    ORCHESTRATION_HANDLERS['orchestration worker-start']({
      client,
      cwd: dir,
      json: true,
      flags: new Map([
        ['spec', 'Which existing test distinguishes the two hypotheses?'],
        ['parent', 'owner-task'],
        ['from', 'term_coord'],
        ['agent', kind === 'execution' ? 'codex' : 'claude'],
        ['model', 'test-model'],
        ['effort', 'medium'],
        ['worktree', 'id:folder::advisor'],
        [`${kind}-policy-file`, 'policy.json']
      ])
    })
  return { run, mutations }
}

it('refuses an older runtime before any advisory worker mutation', async () => {
  const { run, mutations } = await invoke(JSON.stringify(policy), false)
  await expect(run()).rejects.toMatchObject({ code: 'incompatible_runtime' })
  expect(mutations).toEqual([])
})

it('carries an execution policy only when the connected runtime supports it', async () => {
  const executionPolicy = {
    schema: 1,
    sourcePin: 'a'.repeat(40),
    accountFingerprint: `codex:${'b'.repeat(64)}`,
    model: 'test-model',
    effort: 'medium',
    access: 'read-only',
    deadlineAt: 1_800_000_300_000
  }
  const unsupported = await invoke(JSON.stringify(executionPolicy), false, 'execution')
  await expect(unsupported.run()).rejects.toMatchObject({ code: 'incompatible_runtime' })
  expect(unsupported.mutations).toEqual([])
  const supported = await invoke(JSON.stringify(executionPolicy), true, 'execution')
  await supported.run()
  expect(supported.mutations).toEqual([expect.objectContaining({ executionPolicy })])
})

it('refuses malformed private policy without echoing its content', async () => {
  const { run, mutations } = await invoke('{"private detail":', true)
  await expect(run()).rejects.toMatchObject({
    code: 'invalid_argument',
    message: 'Invalid advisory policy file.'
  })
  expect(mutations).toEqual([])
})

it('carries the validated private policy into the original worker-start mutation', async () => {
  const { run, mutations } = await invoke(JSON.stringify(policy), true)
  await run()
  expect(mutations).toEqual([
    expect.objectContaining({ advisoryPolicy: policy, parent: 'owner-task' })
  ])
})
