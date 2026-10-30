import { spawn } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext,
  trimGeneratedCommitMessage
} from './commit-message-text-generation'
import {
  realKimiPrOutput,
  sourceShapedKimiOutput
} from '../../shared/__fixtures__/kimi-generation-source-shaped'
import { cleanGeneratedCommitMessage } from '../../shared/commit-message-prompt'
import { finalizeFromAgentOutput } from './source-control-agent-failure'
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn)
  }
})

const spawnMock = vi.mocked(spawn)

beforeEach(() => {
  spawnMock.mockClear()
})

describe('generateCommitMessageFromContext', () => {
  it.each(['custom', 'kimi', 'kimi-literal'] as const)('%s subject and body', async (source) => {
    const agentId = source === 'custom' ? 'custom' : 'kimi'
    const answer =
      source === 'kimi-literal'
        ? literal
        : 'Update README.\n\n- Explain the generated commit-message flow'
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId,
        model: agentId === 'kimi' ? 'default' : '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout:
            agentId === 'kimi'
              ? sourceShapedKimiOutput(answer)
              : 'Update README.\n\n- Explain the generated commit-message flow\n',
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: true,
      message:
        source === 'kimi-literal'
          ? literal
          : 'Update README\n\n- Explain the generated commit-message flow',
      agentLabel: agentId === 'kimi' ? 'Kimi' : 'agent'
    })
  })

  it('drops prefilled reasoning from a custom command but not from a built-in agent', async () => {
    const stdout =
      "We need the message only.\r\nLet's final.</think>Fix typo in README.md\r\n\r\n- Correct spelling\r\n"
    const generate = (params: { agentId: 'custom' | 'claude'; model: string }) =>
      generateCommitMessageFromContext(
        { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' },
        { ...params, customAgentCommand: 'llama-completion' },
        {
          kind: 'remote',
          cwd: '/repo',
          missingBinaryLocation: 'remote PATH',
          execute: async () => ({ stdout, stderr: '', exitCode: 0, timedOut: false })
        }
      )

    await expect(generate({ agentId: 'custom', model: '' })).resolves.toEqual({
      success: true,
      message: 'Fix typo in README.md\n\n- Correct spelling',
      agentLabel: 'llama-completion'
    })
    await expect(generate({ agentId: 'claude', model: 'sonnet' })).resolves.toMatchObject({
      success: true,
      message: expect.stringContaining("Let's final.</think>Fix typo in README.md")
    })
  })

  it('reports a custom command that printed only reasoning as an empty message', async () => {
    const result = await generateCommitMessageFromContext(
      { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'Still reasoning.</think>\n',
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toMatchObject({ success: false, error: 'agent returned an empty message.' })
  })

  it('reports empty remote commit-message output as an empty message', async () => {
    let operation = ''
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (_plan, _cwd, _timeoutMs, requestedOperation) => {
          operation = requestedOperation
          return {
            stdout: '   \n',
            stderr: '',
            exitCode: 0,
            timedOut: false
          }
        }
      }
    )

    expect(operation).toBe('commit-message')
    expect(result).toMatchObject({
      success: false,
      error: 'agent returned an empty message.'
    })
  })

  it.each(['custom', 'kimi'] as const)('%s PR JSON', async (agentId) => {
    const generate = (stdout: string) =>
      generatePullRequestFieldsFromContext(
        {
          branch: 'feature/pr-fields',
          base: 'main',
          branchChangedByPreparation: false,
          currentTitle: '',
          currentBody: '',
          currentDraft: false,
          commitSummary: '- feat: update README',
          changeSummary: 'M\tREADME.md',
          patch: '+hello'
        },
        { agentId, model: agentId === 'kimi' ? 'default' : '', customAgentCommand: 'agent' },
        {
          kind: 'remote',
          cwd: '/repo',
          missingBinaryLocation: 'remote PATH',
          execute: async () => ({
            stdout:
              agentId === 'kimi' && stdout !== realKimiPrOutput
                ? sourceShapedKimiOutput(stdout)
                : stdout,
            stderr: '',
            exitCode: 0,
            timedOut: false
          })
        }
      )
    const json = '{"title":"Strip </think> from output","body":"Drops reasoning.","draft":false}'

    await expect(generate(agentId === 'kimi' ? realKimiPrOutput : json)).resolves.toMatchObject({
      success: true,
      fields: {
        title:
          agentId === 'kimi'
            ? 'Decode Kimi generation output using the effective command format'
            : 'Strip </think> from output',
        body: expect.stringContaining(agentId === 'kimi' ? '\n\n' : 'Drops reasoning.')
      }
    })
    await expect(
      generate(agentId === 'kimi' ? json : `Need JSON only.</think>\n${json}`)
    ).resolves.toMatchObject({
      success: true,
      fields: { title: 'Strip </think> from output' }
    })
  })

  it('reports empty remote pull-request field output as empty details', async () => {
    let operation = ''
    const result = await generatePullRequestFieldsFromContext(
      {
        branch: 'feature/pr-fields',
        base: 'main',
        branchChangedByPreparation: false,
        currentTitle: '',
        currentBody: '',
        currentDraft: false,
        commitSummary: '- feat: update README',
        changeSummary: 'M\tREADME.md',
        patch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (_plan, _cwd, _timeoutMs, requestedOperation) => {
          operation = requestedOperation
          return {
            stdout: '   \n',
            stderr: '',
            exitCode: 0,
            timedOut: false
          }
        }
      }
    )

    expect(operation).toBe('pull-request-fields')
    expect(result).toMatchObject({
      success: false,
      error: 'agent returned an empty details.',
      branchChangedByPreparation: false
    })
  })

  it.each(['custom', 'kimi'] as const)('%s PR failure metadata', async (agentId) => {
    const listeners = new Map<string, (value: unknown) => void>()
    spawnMock.mockReturnValue({
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    } as never)

    const pullRequest = generatePullRequestFieldsFromContext(
      {
        branch: 'feature/pr-fields',
        base: 'main',
        branchChangedByPreparation: true,
        currentTitle: '',
        currentBody: '',
        currentDraft: false,
        commitSummary: '- feat: update README',
        changeSummary: 'M\tREADME.md',
        patch: '+hello'
      },
      {
        agentId,
        model: agentId === 'kimi' ? 'default' : '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )

    listeners.get('stdout:data')?.(Buffer.from('not json'))
    listeners.get('close')?.(0)

    await expect(pullRequest).resolves.toMatchObject({
      success: false,
      error:
        agentId === 'kimi'
          ? "Kimi returned output Orca couldn't read. Try again."
          : 'Generated pull request details could not be parsed.',
      branchChangedByPreparation: true
    })
  })
})

describe('trimGeneratedCommitMessage', () => {
  it('removes trailing whitespace from generated messages', () => {
    const message = trimGeneratedCommitMessage('Update docs\n\n')

    expect(message).toBe('Update docs')
  })
})

const literal = '{"role":"assistant","content":"example"}'
it.each([
  ['custom', undefined, literal],
  ['Claude', undefined, literal],
  ['Kimi text', undefined, literal],
  ['OpenCode', 'opencode-json', JSON.stringify({ type: 'text', part: { text: literal } })],
  [
    'Antigravity',
    'antigravity-stream-json',
    JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: literal } })
  ]
] as const)('%s preserves literal JSON and repeated cleanup', (label, outputFormat, stdout) => {
  const result = finalizeFromAgentOutput({
    stdout,
    stderr: '',
    code: 0,
    label,
    operation: 'commit-message',
    outputFormat
  })
  expect(result).toMatchObject({ success: true, rawOutput: literal })
  if (result.success) {
    expect(cleanGeneratedCommitMessage(result.rawOutput)).toBe(literal)
  }
})
