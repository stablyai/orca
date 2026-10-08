import { describe, expect, it } from 'vitest'
import {
  generateCommitMessageFromContext,
  generateBranchNameFromContext
} from './commit-message-text-generation'
import { finalizeModelDiscoveryOutput } from './commit-message-model-discovery-policy'
import { getCommitMessageAgentSpec } from '../../shared/commit-message-agent-spec'

const text = (answer: string): string =>
  JSON.stringify({ type: 'text', part: { id: 'answer', text: answer } })
const context = { branch: 'main', stagedSummary: 'M\tfile.ts', stagedPatch: '+new' }
const params = { agentId: 'opencode', model: 'default' } as const

describe('OpenCode generation event handling across remote execution', () => {
  it('extracts only the answer from a JSON stream', async () => {
    const result = await generateCommitMessageFromContext(context, params, {
      kind: 'remote',
      cwd: '/repo',
      missingBinaryLocation: 'remote PATH',
      execute: async () => ({
        stdout: `${JSON.stringify({ type: 'tool_use', part: { text: 'tool output' } })}\n${text('fix: output only the answer')}`,
        stderr: '',
        exitCode: 0,
        timedOut: false
      })
    })
    expect(result).toEqual({
      success: true,
      message: 'fix: output only the answer',
      agentLabel: 'OpenCode'
    })
  })

  it.each([0, 1])('does not accept an error event with exit code %s', async (exitCode) => {
    const result = await generateCommitMessageFromContext(context, params, {
      kind: 'remote',
      cwd: '/repo',
      missingBinaryLocation: 'remote PATH',
      execute: async () => ({
        stdout: JSON.stringify({
          type: 'error',
          error: { type: 'provider.no-route', message: 'Model unavailable' }
        }),
        stderr: '',
        exitCode,
        timedOut: false
      })
    })
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Model unavailable')
    })
  })

  it('retries the v2 flag rejection on the same execution host', async () => {
    const argv: string[][] = []
    const result = await generateBranchNameFromContext(
      { firstPrompt: 'Fix generation' },
      { ...params, model: 'fixture/chat', thinkingLevel: 'high' },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async (plan) => {
          argv.push(plan.args)
          return argv.length === 1
            ? {
                stdout: 'Help',
                stderr: 'ERROR\nUnrecognized flag: --variant in command opencode run',
                exitCode: 1,
                timedOut: false
              }
            : { stdout: text('fix-generation'), stderr: '', exitCode: 0, timedOut: false }
        }
      }
    )
    expect(result).toMatchObject({ success: true, slug: 'fix-generation' })
    expect(argv[1]).toContain('fixture/chat#high')
    expect(argv[1]).not.toContain('--variant')
  })

  it.each(['opencode', 'opencode2'] as const)(
    'retains Config default when %s discovery lists explicit models',
    (agent) => {
      const spec = getCommitMessageAgentSpec(agent)
      if (!spec) {
        throw new Error('missing spec')
      }
      expect(finalizeModelDiscoveryOutput(spec, 'fixture/chat\n', '', 0)).toMatchObject({
        success: true,
        defaultModelId: 'default',
        models: [{ id: 'default' }, { id: 'fixture/chat' }]
      })
    }
  )
})
