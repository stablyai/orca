import { describe, expect, it } from 'vitest'
import { generateCommitMessageFromContext } from './commit-message-text-generation'

describe('commit-message generation regressions', () => {
  it('renders the complete commit policy before handing execution to the owning host', async () => {
    let prompt = ''
    let operation = ''
    const result = await generateCommitMessageFromContext(
      {
        branch: 'feature/policy',
        stagedSummary: 'M src/policy.ts',
        stagedPatch: '+preserve host scope',
        linkedIssue: 73
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent',
        commandInputTemplate:
          '{basePrompt}\n\nBranch: {branch}\nFiles: {stagedFiles}\nPatch: {stagedPatch}\nIssue: {linkedIssue}'
      },
      {
        kind: 'remote',
        cwd: '/remote/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (plan, _cwd, _timeout, generationOperation) => {
          prompt = plan.stdinPayload ?? ''
          operation = generationOperation
          return {
            stdout: 'Preserve source-control policy\n',
            stderr: '',
            exitCode: 0,
            timedOut: false
          }
        }
      }
    )

    expect(operation).toBe('commit-message')
    expect(prompt).toContain('Branch: feature/policy')
    expect(prompt).toContain('Files: M src/policy.ts')
    expect(prompt).toContain('Patch: +preserve host scope')
    expect(prompt).toContain('Issue: 73')
    expect(prompt).not.toMatch(/\{(?:branch|stagedFiles|stagedPatch|linkedIssue)\}/)
    expect(result).toEqual({
      success: true,
      message: 'Preserve source-control policy',
      agentLabel: 'agent'
    })
  })

  it('keeps bounded diagnostic captures out of commit-message results', async () => {
    const result = await generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M src/policy.ts',
        stagedPatch: '+change'
      },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      {
        kind: 'remote',
        cwd: '/remote/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: 'prompt echoed from /Users/private/source/repo',
          stderr: 'failed reading /Users/private/source/repo/.env',
          exitCode: 1,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: false,
      error: 'agent CLI command failed with code 1: failed reading [path]',
      canceled: undefined
    })
    expect(JSON.stringify(result)).not.toContain('/Users/private')
    expect(result).not.toHaveProperty('failureOutput')
  })
})
