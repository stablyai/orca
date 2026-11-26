import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseArgs, validateCommandAndFlags } from './arguments/args'
import { specPaths } from './discovery/command-spec'
import { PIPELINE_COMMAND_SPECS } from './specs/pipeline'
import { dispatch } from './dispatch/dispatch'
import type { RuntimeClient } from './runtime/client'
import { pipelineV2TemplateFixture } from '../shared/pipelines/v2/pipeline-v2.test-fixture'

let root: string
const calls: { method: string; params: unknown }[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-pipeline-v2-cli-'))
  calls.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
async function cli(argv: string[]) {
  const parsed = parseArgs(
    ['pipeline', ...argv],
    PIPELINE_COMMAND_SPECS.flatMap(specPaths),
    PIPELINE_COMMAND_SPECS
  )
  validateCommandAndFlags(PIPELINE_COMMAND_SPECS, parsed)
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params })
      return {
        ok: true,
        result: { version: 2, contractVersion: 2 },
        _meta: { runtimeId: 'runtime-v2' }
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The CLI fixture implements its only transport effect, call; dispatch never opens sockets or uses other RuntimeClient lifecycle methods.
  const transport = client as unknown as RuntimeClient
  await dispatch(parsed.commandPath, {
    flags: parsed.flags,
    cwd: root,
    json: true,
    client: transport
  })
}
it('routes_explicit_v2_reads_and_custom_visit_selectors_without_changing_v1', async () => {
  await cli(['status', '--id', 'run-1'])
  await cli([
    'context',
    '--api-version',
    '2',
    '--id',
    'run-2',
    '--project-id',
    'project-1',
    '--visit-id',
    'custom-visit',
    '--artifact-cursor',
    '4',
    '--limit',
    '2'
  ])
  expect(calls).toEqual([
    { method: 'pipeline.status', params: { id: 'run-1' } },
    {
      method: 'pipeline.v2.context',
      params: {
        id: 'run-2',
        projectId: 'project-1',
        visitId: 'custom-visit',
        artifactCursor: 4,
        limit: 2
      }
    }
  ])
})
it('preserves_literal_template_text_in_a_bounded_file_envelope', async () => {
  const draft = pipelineV2TemplateFixture()
  draft.description = 'Literal $(touch injected); `echo data`'
  for (let index = 0; index < 24; index++) {
    const stage = structuredClone(draft.stages[0])
    stage.id = `custom-${index}`
    stage.instructions = '🔧'.repeat(1450)
    draft.stages.push(stage)
  }
  const envelope = {
    requestId: 'draft-1',
    projectId: 'project-1',
    expectedRuntimeId: 'runtime-v2',
    expectedRevision: 0,
    draft
  }
  const text = JSON.stringify(envelope)
  expect(Buffer.byteLength(text)).toBeGreaterThan(65536)
  await writeFile(join(root, 'draft.json'), text)
  await cli(['template', 'save', '--api-version', '2', '--input-file', 'draft.json'])
  expect(calls[0]).toEqual({ method: 'pipeline.v2.template.save', params: envelope })
})
it('rejects_oversized_regular_mutation_files_before_transport', async () => {
  await writeFile(join(root, 'huge.json'), ' '.repeat(65537))
  await expect(
    cli(['discuss', '--api-version', '2', '--id', 'run-1', '--input-file', 'huge.json'])
  ).rejects.toThrow('64 KiB')
  expect(calls).toEqual([])
})
it.each(['reconcile', 'retry'])(
  'routes %s with all recovery identity guards intact',
  async (command) => {
    await cli([
      command,
      '--api-version',
      '2',
      '--id',
      'run-1',
      '--project-id',
      'project-1',
      '--runtime-id',
      'runtime-v2',
      '--instance-id',
      'instance-1',
      '--request-id',
      'recovery-once',
      '--expected-revision',
      '6'
    ])
    expect(calls).toEqual([
      {
        method: `pipeline.v2.${command}`,
        params: {
          id: 'run-1',
          projectId: 'project-1',
          expectedRuntimeId: 'runtime-v2',
          expectedInstanceId: 'instance-1',
          requestId: 'recovery-once',
          expectedRevision: 6
        }
      }
    ])
  }
)
