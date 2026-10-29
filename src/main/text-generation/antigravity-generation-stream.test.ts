import { describe, expect, it } from 'vitest'
import { parseAntigravityGenerationOutput } from '../../shared/antigravity-generation-stream'
import {
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext
} from './commit-message-text-generation'
import { generatePullRequestFields } from './source-control-text-generation-requests'
import {
  createMockDiscoveryChild,
  withPlatform
} from './commit-message-text-generation-test-harness'

const resultEvent = (response: string, status = 'SUCCESS', error?: string): string =>
  JSON.stringify({ event: 'result', result: { status, response, error } })
const context = {
  branch: 'feature/large-diff',
  base: 'main',
  branchChangedByPreparation: false,
  currentTitle: '',
  currentBody: '',
  currentDraft: false,
  commitSummary: 'Add fixture',
  changeSummary: 'A\tfixture.txt',
  patch: `diff --git a/fixture.txt b/fixture.txt\n+${'x'.repeat(200_000)}`
}
const params = { agentId: 'antigravity', model: 'default' } as const
const fields = { base: 'main', title: 'Add fixture', body: 'Describe the fixture', draft: false }

describe('Antigravity generation stream', () => {
  it('generates pull request fields on Windows without putting a large patch on argv', async () => {
    await withPlatform('win32', async () => {
      const child = createMockDiscoveryChild()
      const pending = generatePullRequestFields({
        context,
        params,
        target: { kind: 'local', cwd: 'C:\\folder-workspace' },
        spawnAgent: (input) => {
          expect(input.args.join(' ').length).toBeLessThan(100)
          expect(input.args).toContain('--input-format=stream-json')
          return child
        }
      })
      const input = JSON.parse(child.stdin.end.mock.calls[0]?.[0] ?? '')
      expect(input.message.content[0].text).toContain('(diff truncated,')
      expect(input.message.content[0].text.length).toBeGreaterThan(200_000)
      child.stdout.emit('data', Buffer.from(resultEvent(JSON.stringify(fields))))
      child.emit('close', 0)
      await expect(pending).resolves.toMatchObject({ success: true, fields })
    })
  })

  it('sends structured stdin and parses only the final answer across remote execution', async () => {
    const result = await generatePullRequestFieldsFromContext(context, params, {
      kind: 'remote',
      cwd: '/folder-workspace',
      missingBinaryLocation: 'remote PATH',
      execute: async (plan) => {
        expect(JSON.parse(plan.stdinPayload ?? '').event).toBe('user')
        return {
          stdout: [
            JSON.stringify({ event: 'init', init: { tools: ['read_file'] } }),
            JSON.stringify({ event: 'step_update', step_update: { text_delta: 'Partial' } }),
            resultEvent(JSON.stringify(fields))
          ].join('\r\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false
        }
      }
    })
    expect(result).toMatchObject({ success: true, fields, agentLabel: 'Antigravity' })
  })

  it('does not treat a failed stream turn as a successful commit message when exit code is zero', async () => {
    const result = await generateCommitMessageFromContext(
      { branch: 'main', stagedSummary: 'A\tfixture.txt', stagedPatch: '+fixture' },
      params,
      {
        kind: 'remote',
        cwd: '/folder-workspace',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: resultEvent('Partial answer', 'ERROR', 'Model unavailable'),
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )
    expect(result).toMatchObject({ success: false, error: 'Model unavailable' })
  })

  it('preserves actionable stderr when a nonzero exit has a malformed result event', async () => {
    const result = await generateCommitMessageFromContext(
      { branch: 'main', stagedSummary: 'A\tfixture.txt', stagedPatch: '+fixture' },
      params,
      {
        kind: 'remote',
        cwd: '/folder-workspace',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '{"event":"result"}',
          stderr: 'Not logged into Antigravity. Run agy login.',
          exitCode: 1,
          timedOut: false
        })
      }
    )
    expect(result).toMatchObject({ success: false })
    if (result.success) {
      throw new Error('Expected generation to fail')
    }
    expect(result.error).toContain('Not logged into Antigravity. Run agy login.')
    expect(result.error).not.toContain('invalid result')
  })

  it.each([
    'plain output',
    '{"event":"result"}',
    '{"event":"step_update","step_update":{"text_delta":"Partial"}}',
    '{"event":"result","result":{"status":"SUCCESS","response":42}}'
  ])('rejects malformed or incomplete output: %s', (output) => {
    expect(parseAntigravityGenerationOutput(output)).toMatchObject({ ok: false })
  })
})
