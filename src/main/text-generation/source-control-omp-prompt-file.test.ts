import { spawnProcess } from '@orca/process-host'
import * as agentSpecs from '../../shared/commit-message-agent-spec'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import type { SpawnSourceControlAgent } from './source-control-text-generation-types'
import {
  generateCommitMessage,
  generatePullRequestFields,
  generateBranchName
} from './source-control-text-generation-requests'
import { generateConversationName } from './conversation-name-generation-request'
import { generateJiraIssueSummaryFromContext } from './jira-issue-summary-text-generation'

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { planCommitMessageGeneration } from '../../shared/commit-message-plan'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'
import { runLocalSourceControlPlan } from './source-control-local-process'
import {
  createMockDiscoveryChild,
  withPlatform
} from './commit-message-text-generation-test-harness'

vi.mock('../windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: vi.fn(async () => true)
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

const actualFs = await vi.importActual<typeof FsPromises>('node:fs/promises')

afterEach(() => vi.useRealTimers())

// OMP 17.0.5 recorded stdin-only execution: exit 0, empty stdout/stderr, no submitted prompt.
const recordedPrompt = `Name this chat from the user's first request.
Write a short, specific title of at most 48 characters.
Output only the title, with no heading, quotes, or explanation.

First request:
Trace a lost lighthouse signal.

Additional instructions:
Return Lighthouse Signal Trace.
`

it.each(['success', 'failure', 'cancel', 'timeout', 'spawn failure'] as const)(
  'delivers the recorded OMP prompt without stdin and removes the owned file after %s',
  async (outcome) => {
    vi.useFakeTimers()
    const prompt = recordedPrompt + 'x'.repeat(200_000)
    const planned = planCommitMessageGeneration({ agentId: 'omp', model: 'default' }, prompt)
    if (!planned.ok) {
      throw new Error(planned.error)
    }
    const child = createMockDiscoveryChild()
    let promptPath = ''
    const execution = withPlatform('win32', () =>
      runLocalSourceControlPlan({
        plan: planned.plan,
        cwd: '/omp-file-test',
        env: undefined,
        operation: 'conversation-name',
        spawnAgent: ({ args }) => {
          promptPath = args[planned.plan.promptFile?.argIndex ?? -1]?.slice(1) ?? ''
          expect(new TextDecoder().decode(readFileSync(promptPath))).toBe(prompt)
          expect(args.join(' ').length).toBeLessThan(1000)
          if (outcome === 'spawn failure') {
            throw new Error('recorded spawn failure')
          }
          return child
        }
      })
    )
    if (outcome === 'success') {
      // Like the recorded binary, this child never reads stdin; only the explicit file submits input.
      child.stdout.emit('data', Buffer.from('Lighthouse Signal Trace'))
    } else if (outcome === 'cancel') {
      cancelLocalGeneration('conversation-name', '/omp-file-test')
    } else if (outcome === 'timeout') {
      await vi.advanceTimersByTimeAsync(SOURCE_CONTROL_GENERATION_TIMEOUT_MS)
    }
    if (outcome !== 'spawn failure') {
      expect(child.stdin.end).toHaveBeenCalledWith(undefined)
      expect(existsSync(promptPath)).toBe(true)
      child.emit('close', outcome === 'failure' ? 1 : 0)
    }
    const result = await execution.result
    await execution.processClosed
    expect(result.success).toBe(outcome === 'success')
    await vi.waitFor(() => expect(existsSync(dirname(promptPath))).toBe(false))
  }
)

// Pinned OMP17 cli/file-processor.ts:16,49-54,119-122: per-file cap, ordered text decoding.
const attachmentReader = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(1);
const paths = args.filter(arg => arg.startsWith('@')).map(arg => arg.slice(1));
const chunks = paths.map(path => fs.readFileSync(path));
const isImage = bytes => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) ||
  (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
const fragments = chunks.map(bytes => bytes.length > 5 * 1024 * 1024
  ? '(skipped: too large)' : isImage(bytes) ? '(image instead of text)' : new TextDecoder().decode(bytes));
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.OMP_RECEIPT, JSON.stringify({
    paths, sizes: chunks.map(bytes => bytes.length), content: paths.length ? fragments.join('') : stdin, stdin,
    message: fragments.map((text, index) => '<file name="' + paths[index] + '">\n' + text + '\n</file>\n').join('') + args.at(-1)
  }));
  process.stdout.write(process.env.OMP_OUTPUT);
  if (process.env.OMP_EXIT === '7') process.stderr.write('Fixture provider unavailable');
  process.exitCode = Number(process.env.OMP_EXIT);
});
`

const contractParams = {
  agentId: 'omp',
  model: 'generated/model',
  thinkingLevel: 'low',
  agentCommandOverride: 'OMP_RECIPE_ENV=kept node /configured/prefix/omp.js --model prefix/model',
  agentArgs: '--model recipe/model --thinking high -- recipe-message',
  commandInputTemplate: 'Saved recipe instruction\n{basePrompt}'
} as const
const contractTarget = { kind: 'local', cwd: tmpdir() } as const
const commitContext = {
  branch: 'feature',
  stagedSummary: 'signal.ts | 1 +',
  stagedPatch: '+ Trace lighthouse signal'
}

type Consumer = {
  label: string
  run(
    params: ResolvedSourceControlAiGenerationParams,
    spawnAgent: SpawnSourceControlAgent
  ): Promise<unknown>
  output: string
  expected: object
}
const consumers: Consumer[] = [
  {
    label: 'commit',
    run: (params, spawnAgent) =>
      generateCommitMessage({ context: commitContext, params, target: contractTarget, spawnAgent }),
    output: 'Trace lighthouse signal.\n\nPreserve request bytes\n',
    expected: { message: 'Trace lighthouse signal\n\nPreserve request bytes' }
  },
  {
    label: 'PR fields',
    run: (params, spawnAgent) =>
      generatePullRequestFields({
        context: {
          branch: 'feature',
          base: 'main',
          branchChangedByPreparation: true,
          currentTitle: '',
          currentBody: '',
          currentDraft: false,
          commitSummary: 'Trace lighthouse signal',
          changeSummary: 'signal.ts',
          patch: '+ Trace lighthouse signal'
        },
        params,
        target: contractTarget,
        spawnAgent
      }),
    output: JSON.stringify({
      base: 'main',
      title: 'Trace lighthouse signal.',
      body: 'Preserve request bytes\n',
      draft: true
    }),
    expected: {
      fields: {
        base: 'main',
        title: 'Trace lighthouse signal',
        body: 'Preserve request bytes',
        draft: true
      },
      branchChangedByPreparation: true
    }
  },
  {
    label: 'branch slug / folder title',
    run: (params, spawnAgent) =>
      generateBranchName({
        context: { firstPrompt: 'Trace lighthouse signal' },
        params,
        target: contractTarget,
        spawnAgent
      }),
    output: 'Trace Lighthouse Signal!',
    expected: { slug: 'trace-lighthouse-signal' }
  },
  {
    label: 'conversation name',
    run: (params, spawnAgent) =>
      generateConversationName({
        context: { firstPrompt: 'Trace lighthouse signal' },
        params,
        target: contractTarget,
        spawnAgent
      }),
    output: '# Title: "Trace lighthouse signal"\nextra commentary',
    expected: { name: 'Trace lighthouse signal' }
  },
  {
    label: 'Jira summary',
    run: (params, spawnAgent) =>
      generateJiraIssueSummaryFromContext(
        { description: 'Trace lighthouse signal' },
        params,
        contractTarget,
        spawnAgent
      ),
    output: '"Trace lighthouse signal"\nextra commentary',
    expected: { summary: 'Trace lighthouse signal' }
  }
]

type Receipt = { paths: string[]; sizes: number[]; content: string; stdin: string; message: string }
async function withReader<T>(
  output: string,
  fail: boolean,
  run: (spawnAgent: SpawnSourceControlAgent) => Promise<T>
) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-omp-contract-'))
  const receiptPath = join(directory, 'receipt.json')
  try {
    const result = await run((input) => {
      expect(input.binary).toBe('node')
      expect(input.args.slice(0, 1)).toEqual(['/configured/prefix/omp.js'])
      expect(input.args).toContain('recipe/model')
      expect(input.args).not.toContain('prefix/model')
      expect(input.args).not.toContain('generated/model')
      expect(input.args).toContain('high')
      expect(input.args).not.toContain('low')
      expect(input.args.slice(-2)).toEqual(['--', 'recipe-message'])
      expect(input.commandEnv).toEqual({ OMP_RECIPE_ENV: 'kept' })
      return spawnProcess({
        program: process.execPath,
        args: ['-e', attachmentReader, '--', ...input.args],
        cwd: input.cwd,
        env: {
          ...process.env,
          OMP_RECEIPT: receiptPath,
          OMP_OUTPUT: output,
          OMP_EXIT: fail ? '7' : '0'
        },
        stdio: 'pipe'
      })
    })
    const receipt: Receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    await vi.waitFor(() => {
      for (const path of receipt.paths) {
        expect(existsSync(dirname(path))).toBe(false)
      }
    })
    return { result, receipt }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

it.each(consumers)(
  'preserves $label output and failure classification across stdin/file transport',
  async (consumer) => {
    const spec = agentSpecs.getCommitMessageAgentSpec('omp')
    if (!spec) {
      throw new Error('Missing OMP spec')
    }
    for (const fail of [false, true]) {
      const delivered = await withReader(consumer.output, fail, (spawn) =>
        consumer.run(contractParams, spawn)
      )
      expect(delivered.receipt.paths).toHaveLength(1)
      expect(delivered.receipt.stdin).toBe('')
      expect(delivered.receipt.message.endsWith('recipe-message')).toBe(true)
      expect(delivered.receipt.content).toContain('Trace lighthouse signal')
      expect(delivered.receipt.content.includes('Saved recipe instruction')).toBe(
        consumer.label !== 'Jira summary'
      )
      if (fail) {
        expect(delivered.result).toMatchObject({
          success: false,
          error: expect.stringContaining('OMP CLI command failed with code 7')
        })
      } else {
        expect(delivered.result).toMatchObject({
          success: true,
          agentLabel: 'OMP',
          ...consumer.expected
        })
      }
      const legacy = vi.spyOn(agentSpecs, 'getCommitMessageAgentSpec').mockReturnValue({
        ...spec,
        promptDelivery: 'stdin',
        buildArgs: (params) => spec.buildArgs(params).slice(0, -1)
      })
      try {
        const previous = await withReader(consumer.output, fail, (spawn) =>
          consumer.run(contractParams, spawn)
        )
        expect(previous.receipt.paths).toHaveLength(0)
        expect(previous.receipt.content).toBe(delivered.receipt.content)
        expect(previous.result).toEqual(delivered.result)
      } finally {
        legacy.mockRestore()
      }
    }
  }
)

it.each(['below', 'at', 'above', 'multibyte', 'BOM run', 'GIF', 'RIFF', 'internal magic'] as const)(
  'delivers complete text recipe content: %s',
  async (boundary) => {
    const cap = 5 * 1024 * 1024
    const payloadCap = cap - 3
    const patches = {
      below: () => 'x'.repeat(payloadCap - 1),
      at: () => 'x'.repeat(payloadCap),
      above: () => 'x'.repeat(cap + 1),
      multibyte: () =>
        `${'x'.repeat(payloadCap - 1)}🌊界é${'界'.repeat(Math.ceil(cap / 3))}\uFEFFEND`,
      'BOM run': () => `${'\uFEFF'.repeat(Math.ceil(cap / 3))}Preserve every BOM`,
      GIF: () => 'GIF89a is the header this change handles. Preserve this as text.',
      RIFF: () => 'RIFFxxxxWEBP is the signature this change handles. Preserve this as text.',
      'internal magic': () => `${'x'.repeat(payloadCap)}GIF89a preserve this boundary as text.`
    }
    const patch = patches[boundary]()
    const { result, receipt } = await withReader(
      'Preserve the complete request',
      false,
      (spawnAgent) =>
        generateCommitMessage({
          context: { ...commitContext, stagedPatch: patch },
          params: { ...contractParams, commandInputTemplate: '{stagedPatch}' },
          target: contractTarget,
          spawnAgent
        })
    )
    expect(result).toMatchObject({ success: true, message: 'Preserve the complete request' })
    expect(receipt.content).toBe(patch)
    expect(receipt.sizes.every((size) => size <= cap)).toBe(true)
    expect(receipt.paths).toHaveLength(
      boundary === 'multibyte'
        ? 3
        : ['above', 'BOM run', 'internal magic'].includes(boundary)
          ? 2
          : 1
    )
    if (boundary === 'at') {
      expect(receipt.sizes).toEqual([cap])
    }
  }
)

it.each(['success', 'spawn failure', 'permanent failure'] as const)(
  'settles independently of bounded async cleanup after %s',
  async (outcome) => {
    const originalPlatform = process.platform
    const rmMock = vi.mocked(rm)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const locked = Object.assign(new Error('EPERM: prompt handle held'), { code: 'EPERM' })
    let directory = ''
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    rmMock.mockClear()
    rmMock.mockImplementationOnce(async () => {
      throw locked
    })
    if (outcome === 'permanent failure') {
      rmMock.mockRejectedValue(locked)
    }
    try {
      const planned = planCommitMessageGeneration(
        { agentId: 'omp', model: 'default' },
        recordedPrompt
      )
      if (!planned.ok) {
        throw new Error(planned.error)
      }
      const child = createMockDiscoveryChild()
      const execution = runLocalSourceControlPlan({
        plan: planned.plan,
        cwd: '/omp-cleanup',
        env: undefined,
        operation: 'conversation-name',
        spawnAgent: ({ args }) => {
          directory = dirname(args[planned.plan.promptFile?.argIndex ?? -1].slice(1))
          if (outcome === 'spawn failure') {
            throw new Error('Fixture spawn failure')
          }
          return child
        }
      })
      if (outcome !== 'spawn failure') {
        child.stdout.emit('data', Buffer.from('Lighthouse Signal Trace'))
        child.emit('close', 0)
      }
      expect((await execution.result).success).toBe(outcome !== 'spawn failure')
      await execution.processClosed
      expect(rmMock).toHaveBeenCalledTimes(1)
      expect(existsSync(directory)).toBe(true)
      if (outcome === 'permanent failure') {
        await vi.waitFor(
          () =>
            expect(errors).toHaveBeenCalledWith(
              '[commit-message] Failed to remove generation prompt:',
              locked
            ),
          { timeout: 5000 }
        )
        expect(rmMock).toHaveBeenCalledTimes(5)
        expect(errors).toHaveBeenCalledTimes(1)
        expect(existsSync(directory)).toBe(true)
      } else {
        await vi.waitFor(() => expect(existsSync(directory)).toBe(false), { timeout: 2000 })
        expect(rmMock).toHaveBeenCalledTimes(2)
      }
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      rmMock.mockImplementation(actualFs.rm)
      if (directory) {
        await actualFs.rm(directory, { recursive: true, force: true })
      }
      errors.mockRestore()
    }
  }
)
