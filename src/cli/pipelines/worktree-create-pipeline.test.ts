import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readWorktreePipeline } from './worktree-create-pipeline'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-pipeline-create-cli-'))
})
afterEach(async () => rm(root, { recursive: true, force: true }))
function context(extra: [string, string | boolean][]): HandlerContext {
  const flags = new Map<string, string | boolean>([
    ['name', 'Task name'],
    ['pipeline', 'custom'],
    ['request-id', 'creation-1'],
    ...extra
  ])
  const client = {
    call: async (method: string) => ({
      ok: true,
      _meta: { runtimeId: 'runtime-v2' },
      result: {
        contractVersion: 2,
        profiles: [
          {
            id: 'custom',
            version: '3',
            digest: 'a'.repeat(64),
            ...(method === 'pipeline.v2.profiles'
              ? { engineVersion: 2, projectId: 'project-1' }
              : {})
          }
        ]
      }
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The CLI fixture implements its only transport effect, call; dispatch never opens sockets or uses other RuntimeClient lifecycle methods.
  const transport = client as unknown as RuntimeClient
  return { flags, client: transport, cwd: root, json: true }
}
it('keeps_legacy_pipeline_task_and_selection_on_v1', async () => {
  expect(await readWorktreePipeline(context([['comment', 'Acceptance criteria']]))).toEqual({
    creationId: 'creation-1',
    pipeline: {
      profile: { id: 'custom', version: '3', digest: 'a'.repeat(64) },
      task: 'Task name\nAcceptance criteria'
    }
  })
})
it('pins_the_v2_project_version_and_runtime_and_preserves_a_separate_unicode_task', async () => {
  const task = 'Изучи задачу и предложи план 🔧\n$(touch data)'
  expect(
    await readWorktreePipeline(
      context([
        ['api-version', '2'],
        ['pipeline-project-id', 'project-1'],
        ['pipeline-task', task]
      ])
    )
  ).toEqual({
    creationId: 'creation-1',
    pipeline: {
      profile: {
        engineVersion: 2,
        projectId: 'project-1',
        id: 'custom',
        version: '3',
        digest: 'a'.repeat(64)
      },
      expectedRuntimeId: 'runtime-v2',
      task
    }
  })
})
it('reads_plain_utf8_task_files_without_trimming_or_starting_any_agent', async () => {
  const task = '  Изучи задачу\nСохрани пробелы и перевод строки.\n'
  await writeFile(join(root, 'task.txt'), task)
  const result = await readWorktreePipeline(
    context([
      ['api-version', '2'],
      ['pipeline-project-id', 'project-1'],
      ['pipeline-task-file', 'task.txt']
    ])
  )
  expect(result?.pipeline.task).toBe(task)
})
