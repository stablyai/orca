import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { planCommitMessageGeneration } from '../../shared/source-control/ai/generation/commit-message-plan'
import { prepareOpenCodeTextTaskInput } from './opencode-text-task-input'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'opencode-text-input-'))
  roots.push(root)
  await mkdir(path.join(root, 'nested'))
  await writeFile(path.join(root, 'context.txt'), 'original context')
  return root
}

it('preserves recipe directory, relative attachment, positional input and global behavior', async () => {
  const cwd = await workspace()
  const planned = planCommitMessageGeneration(
    {
      agentId: 'opencode',
      model: 'default',
      agentCommandOverride: 'opencode --pure',
      agentArgs:
        '--dir nested --file ../context.txt --agent custom --title=Recipe -- "extra instructions"'
    },
    'generated input'
  )
  if (!planned.ok || !planned.plan.openCodeTask) {
    throw new Error('No OpenCode plan')
  }
  const input = await prepareOpenCodeTextTaskInput({
    version: 'v1',
    cwd,
    prompt: 'generated input',
    runArgs: planned.plan.openCodeTask.runArgs,
    signal: new AbortController().signal
  })
  expect(input).toMatchObject({
    directory: path.join(cwd, 'nested'),
    prompt: '"extra instructions"\ngenerated input',
    serverArgs: ['--pure'],
    agent: 'custom',
    title: 'Recipe',
    v1Files: [
      {
        type: 'file',
        filename: 'context.txt',
        mime: 'text/plain',
        url: pathToFileURL(path.join(cwd, 'context.txt')).href
      }
    ]
  })
})

it('projects v2 text files and binary attachments into the vendor native request shape', async () => {
  const cwd = await workspace()
  await writeFile(path.join(cwd, 'diagram.png'), Buffer.from([137, 80, 78, 71]))
  const input = await prepareOpenCodeTextTaskInput({
    version: 'v2',
    cwd,
    prompt: 'generated input',
    runArgs: [
      '--file',
      'context.txt',
      '--file=diagram.png',
      '--model=provider/model#low',
      '--',
      'extra'
    ],
    signal: new AbortController().signal
  })
  expect(input.prompt).toBe(
    'extra\ngenerated input\n\n<file name="context.txt">\noriginal context\n</file>'
  )
  expect(input.v2Files).toEqual([{ name: 'diagram.png', uri: 'data:image/png;base64,iVBORw==' }])
  expect(input.model).toBe('provider/model#low')
  await expect(
    prepareOpenCodeTextTaskInput({
      version: 'v2',
      cwd,
      prompt: 'input',
      runArgs: ['--dir', 'nested'],
      signal: new AbortController().signal
    })
  ).rejects.toThrow('unsupported')
})

it('retains wrapper operands outside the run parser and keeps command arguments distinct', async () => {
  const cwd = await workspace()
  await writeFile(path.join(cwd, 'notes.txt'), 'read-only context')
  const planned = planCommitMessageGeneration(
    {
      agentId: 'opencode',
      model: 'opencode/gpt-5.4-mini',
      agentCommandOverride:
        'npx --yes opencode --model opencode/gpt-5.5 --log-level DEBUG --dir . --file notes.txt',
      agentArgs: '--command review --agent build -- extra'
    },
    'generated input'
  )
  if (!planned.ok || !planned.plan.openCodeTask) {
    throw new Error('No OpenCode plan')
  }
  expect(planned.plan.openCodeTask.prefixArgs).toEqual(['--yes', 'opencode'])
  const input = await prepareOpenCodeTextTaskInput({
    version: 'v1',
    cwd,
    prompt: 'generated input',
    runArgs: planned.plan.openCodeTask.runArgs,
    signal: new AbortController().signal
  })
  expect(input).toMatchObject({
    command: 'review',
    prompt: 'extra\ngenerated input',
    agent: 'build',
    model: 'opencode/gpt-5.5',
    serverArgs: ['--log-level', 'DEBUG'],
    v1Files: [
      {
        type: 'file',
        mime: 'text/plain',
        filename: 'notes.txt',
        url: expect.stringContaining('/notes.txt')
      }
    ]
  })
})

it('keeps a wrapper run operand attached to the selected executable', async () => {
  const planned = planCommitMessageGeneration(
    {
      agentId: 'opencode',
      model: 'default',
      agentCommandOverride: 'pnpm run opencode'
    },
    'generated input'
  )
  if (!planned.ok || !planned.plan.openCodeTask) {
    throw new Error('No OpenCode plan')
  }
  expect(planned.plan.binary).toBe('pnpm')
  expect(planned.plan.openCodeTask.prefixArgs).toEqual(['run', 'opencode'])
  const input = await prepareOpenCodeTextTaskInput({
    version: 'v1',
    cwd: await workspace(),
    prompt: 'generated input',
    runArgs: planned.plan.openCodeTask.runArgs,
    signal: new AbortController().signal
  })
  expect(input.prompt).toBe('generated input')
})

it('preserves the original OpenCode v2 variant compatibility without accepting it for other recipes', async () => {
  const cwd = await workspace()
  for (const model of ['provider/model', 'provider/model#high']) {
    const input = await prepareOpenCodeTextTaskInput({
      version: 'v2',
      cwd,
      prompt: 'input',
      legacyVariantFlag: true,
      runArgs: ['--model', model, '--variant', 'low'],
      signal: new AbortController().signal
    })
    expect(input.model).toBe('provider/model#low')
    expect(input.variant).toBeUndefined()
    expect(input.serverArgs).toEqual([])
  }
  await expect(
    prepareOpenCodeTextTaskInput({
      version: 'v2',
      cwd,
      prompt: 'input',
      runArgs: ['--model', 'provider/model', '--variant', 'low'],
      signal: new AbortController().signal
    })
  ).rejects.toThrow('unsupported')
  await expect(
    prepareOpenCodeTextTaskInput({
      version: 'v2',
      cwd,
      prompt: 'input',
      legacyVariantFlag: true,
      runArgs: ['--variant', 'low'],
      signal: new AbortController().signal
    })
  ).rejects.toThrow('requires a model')
})

it('projects npx delimiter arguments without consuming the provider terminator', async () => {
  const cwd = await workspace()
  await writeFile(path.join(cwd, 'nested', 'notes.txt'), 'selected context')
  const planned = planCommitMessageGeneration(
    {
      agentId: 'opencode',
      model: 'default',
      agentCommandOverride: 'npx -- opencode --dir nested --file notes.txt'
    },
    'Name this chat'
  )
  if (!planned.ok || !planned.plan.openCodeTask) {
    throw new Error('Missing native task')
  }
  expect(planned.plan.openCodeTask.prefixArgs).toEqual(['--', 'opencode'])
  const input = await prepareOpenCodeTextTaskInput({
    version: 'v1',
    cwd,
    prompt: 'Name this chat',
    runArgs: planned.plan.openCodeTask.runArgs,
    signal: new AbortController().signal
  })
  expect(input.directory).toBe(path.join(cwd, 'nested'))
  expect(input.v1Files).toEqual([
    {
      type: 'file',
      mime: 'text/plain',
      filename: 'notes.txt',
      url: pathToFileURL(path.join(cwd, 'nested', 'notes.txt')).href
    }
  ])
  const positional = planCommitMessageGeneration(
    { agentId: 'opencode', model: 'default', agentCommandOverride: 'npx -- opencode -- literal' },
    'input'
  )
  if (!positional.ok || !positional.plan.openCodeTask) {
    throw new Error('Missing native task')
  }
  expect(positional.plan.openCodeTask.prefixArgs).toEqual(['--', 'opencode'])
  expect(positional.plan.openCodeTask.runArgs.slice(0, 2)).toEqual(['--', 'literal'])
})
