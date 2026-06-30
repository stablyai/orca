import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { PipelineDb } from './db'
import { PipelinePromptRenderError, renderPipelinePrompt } from './prompt-renderer'
import type { PipelinePromptDefinition } from '../../shared/pipeline-template-types'
import type { PipelineRunInput } from '../../shared/pipelines-types'

const templatePrompt: PipelinePromptDefinition = {
  id: 'test-template-prompt',
  stage: 'planner',
  source: { type: 'template', text: 'Hello {{NAME}}\n!`{{LIST_TASKS_COMMAND}}`' },
  acceptsArgs: true
}

describe('renderPipelinePrompt', () => {
  let db: PipelineDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
    db = undefined
    tempDir = undefined
  })

  it('renders prompt args, expands raw dynamic context, and records the DB result', async () => {
    db = new PipelineDb(':memory:')
    const run = db.createRun(runInput())
    const stage = db.createStage({ runId: run.id, stage: 'planner', status: 'running' })
    const commands: string[] = []

    const result = await renderPipelinePrompt({
      prompt: templatePrompt,
      builtInArgs: { LIST_TASKS_COMMAND: 'list tasks' },
      userArgs: { NAME: 'Orca' },
      cwd: '/repo',
      runId: run.id,
      stageId: stage.id,
      templateId: run.templateId,
      db,
      commandRunner: async ({ command, cwd }) => {
        commands.push(`${cwd}:${command}`)
        return { exitCode: 0, timedOut: false, stdout: 'task output\n', stderr: '' }
      }
    })

    expect(commands).toEqual(['/repo:list tasks'])
    expect(result.prompt).toBe('Hello Orca\ntask output')
    expect(db.listDynamicContextResults(run.id)).toMatchObject([
      {
        runId: run.id,
        stageId: stage.id,
        command: 'list tasks',
        stdout: 'task output\n',
        stdoutTruncated: false
      }
    ])
  })

  it('does not execute dynamic context injected through user args', async () => {
    const commands: string[] = []
    const result = await renderPipelinePrompt({
      prompt: {
        ...templatePrompt,
        source: { type: 'template', text: 'Issue text: {{ISSUE_BODY}}' }
      },
      builtInArgs: {},
      userArgs: { ISSUE_BODY: '!`echo hacked`' },
      cwd: '/repo',
      commandRunner: async ({ command }) => {
        commands.push(command)
        return { exitCode: 0, timedOut: false, stdout: 'bad', stderr: '' }
      }
    })

    expect(commands).toEqual([])
    expect(result.prompt).toBe('Issue text: !`echo hacked`')
  })

  it('rejects built-in overrides, missing args, inline prompt args, and user command placeholders', async () => {
    await expect(
      renderPipelinePrompt({
        prompt: templatePrompt,
        builtInArgs: { SOURCE_BRANCH: 'main', LIST_TASKS_COMMAND: 'list tasks' },
        userArgs: { SOURCE_BRANCH: 'evil', NAME: 'Orca' },
        cwd: '/repo'
      })
    ).rejects.toMatchObject({ code: 'built_in_arg_override' })

    await expect(
      renderPipelinePrompt({
        prompt: templatePrompt,
        builtInArgs: { LIST_TASKS_COMMAND: 'list tasks' },
        userArgs: {},
        cwd: '/repo'
      })
    ).rejects.toMatchObject({ code: 'missing_prompt_arg' })

    await expect(
      renderPipelinePrompt({
        prompt: { ...templatePrompt, source: { type: 'inline', text: 'Hello {{NAME}}' } },
        builtInArgs: {},
        userArgs: { NAME: 'Orca' },
        cwd: '/repo'
      })
    ).rejects.toMatchObject({ code: 'inline_prompt_args' })

    await expect(
      renderPipelinePrompt({
        prompt: {
          ...templatePrompt,
          source: { type: 'template', text: '!`{{USER_COMMAND}}`' }
        },
        builtInArgs: {},
        userArgs: { USER_COMMAND: 'echo unsafe' },
        cwd: '/repo'
      })
    ).rejects.toMatchObject({ code: 'dynamic_context_user_arg' })
  })

  it('fails and records dynamic context timeout, non-zero exit, and output truncation', async () => {
    db = new PipelineDb(':memory:')
    const run = db.createRun(runInput())
    const stage = db.createStage({ runId: run.id, stage: 'planner', status: 'running' })

    await expect(
      renderPipelinePrompt({
        prompt: {
          ...templatePrompt,
          source: { type: 'template', text: '!`{{LIST_TASKS_COMMAND}}`' }
        },
        builtInArgs: { LIST_TASKS_COMMAND: 'fail command' },
        cwd: '/repo',
        runId: run.id,
        stageId: stage.id,
        templateId: run.templateId,
        db,
        commandRunner: async () => ({
          exitCode: 2,
          timedOut: false,
          stdout: 'a'.repeat(10),
          stderr: 'b'.repeat(10)
        }),
        maxStdoutChars: 4,
        maxStderrChars: 5
      })
    ).rejects.toBeInstanceOf(PipelinePromptRenderError)

    expect(db.listDynamicContextResults(run.id)).toMatchObject([
      {
        command: 'fail command',
        exitCode: 2,
        stdout: 'aaaa',
        stderr: 'bbbbb',
        stdoutTruncated: true,
        stderrTruncated: true
      }
    ])

    await expect(
      renderPipelinePrompt({
        prompt: {
          ...templatePrompt,
          source: { type: 'template', text: '!`{{LIST_TASKS_COMMAND}}`' }
        },
        builtInArgs: { LIST_TASKS_COMMAND: 'slow command' },
        cwd: '/repo',
        commandRunner: async () => ({
          exitCode: null,
          timedOut: true,
          stdout: '',
          stderr: 'timed out'
        })
      })
    ).rejects.toMatchObject({ code: 'dynamic_context_timeout' })
  })

  it('runs dynamic context against a real temp cwd', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pipeline-prompt-'))

    const result = await renderPipelinePrompt({
      prompt: {
        ...templatePrompt,
        source: { type: 'template', text: 'cwd: !`node -p "process.cwd()"`' }
      },
      builtInArgs: {},
      userArgs: {},
      cwd: tempDir
    })

    expect(result.prompt).toBe(`cwd: ${tempDir}`)
  })
})

function runInput(): PipelineRunInput {
  return {
    templateId: 'parallel-planner-with-review',
    repoId: 'repo_orca',
    sourceBranch: 'main',
    targetBranch: 'pipeline-output',
    taskSource: { type: 'manual', tasks: [{ id: '1', title: 'One', body: 'Do one thing' }] },
    maxConcurrent: 2,
    maxIterations: 1,
    plannerAgentId: 'codex',
    implementerAgentId: 'codex',
    mergerAgentId: 'codex',
    executionTargetType: 'local'
  }
}
