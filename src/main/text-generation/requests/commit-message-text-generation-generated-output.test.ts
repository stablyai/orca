import 'node:child_process'

import { describe, expect, it } from 'vitest'
import {
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext
} from '../commit-message-text-generation'
import {
  realKimiPrOutput,
  sourceShapedKimiOutput
} from '../../../shared/__fixtures__/kimi-generation-source-shaped'
import '../../../shared/source-control/ai/generation/commit-message-agent-output'
import '../failures/source-control-agent-failure'

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
})

const literal = '{"role":"assistant","content":"example"}'
