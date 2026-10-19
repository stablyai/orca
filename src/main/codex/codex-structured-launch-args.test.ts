import { describe, expect, it } from 'vitest'
import { codexStructuredLaunchArgs } from './codex-structured-launch-args'
import { StructuredAgentArgumentsError } from '../native-chat/structured-agent-arguments-error'

describe('codexStructuredLaunchArgs', () => {
  it('preserves root config and feature option order', () => {
    expect(
      codexStructuredLaunchArgs([
        '-c',
        'model_reasoning_effort=high',
        '--enable',
        'unified_exec',
        '--config=web_search="live"',
        '--disable=some_feature',
        '-m',
        'gpt-5.6-sol'
      ])
    ).toEqual([
      '-c',
      'model_reasoning_effort=high',
      '--enable',
      'unified_exec',
      '--config=web_search="live"',
      '--disable=some_feature',
      '-m',
      'gpt-5.6-sol'
    ])
  })

  it('drops permission options and config overrides owned by Orca', () => {
    expect(
      codexStructuredLaunchArgs([
        '--dangerously-bypass-approvals-and-sandbox',
        '-a',
        'never',
        '--sandbox=danger-full-access',
        '--approve-for-me',
        '-c',
        'approval_policy="never"',
        '--config=sandbox_mode="danger-full-access"',
        '-c',
        'sandbox_workspace_write.writable_roots=["/tmp"]',
        '-c',
        '"sandbox_workspace_write".writable_roots=["/tmp"]',
        '-c',
        '\'approval_policy\'="never"',
        '-c',
        'model_reasoning_effort=high'
      ])
    ).toEqual(['-c', 'model_reasoning_effort=high'])
  })

  it('drops a profile and TUI-only path options without leaving their values as prompts', () => {
    expect(
      codexStructuredLaunchArgs([
        '--profile',
        'review',
        '-pother',
        '--cd',
        '/another/repo',
        '--worktree',
        '-c',
        'model_reasoning_effort=high'
      ])
    ).toEqual(['-c', 'model_reasoning_effort=high'])
  })

  it('discards operands after the option terminator', () => {
    expect(
      codexStructuredLaunchArgs(['-c', 'model_reasoning_effort=high', '--', 'a prompt'])
    ).toEqual(['-c', 'model_reasoning_effort=high'])
  })

  it.each([
    { tokens: ['a private prompt'], option: 'prompt', problem: 'positionalPrompt' },
    { tokens: ['app-server'], option: 'prompt', problem: 'positionalPrompt' },
    {
      tokens: ['--remote', 'wss://private-host'],
      option: '--remote',
      problem: 'unsupportedOption'
    },
    { tokens: ['--remote=wss://private-host'], option: '--remote', problem: 'unsupportedOption' },
    {
      tokens: ['--remote-auth-token-env', 'PRIVATE_TOKEN'],
      option: '--remote-auth-token-env',
      problem: 'unsupportedOption'
    },
    { tokens: ['--unknown-flag=secret'], option: '--unknown-flag', problem: 'unsupportedOption' },
    { tokens: ['--enable'], option: '--enable', problem: 'missingValue' }
  ] as const)('rejects unsafe or incomplete arguments: %j', ({ tokens, option, problem }) => {
    const thrown = () => codexStructuredLaunchArgs(tokens)
    expect(thrown).toThrow(StructuredAgentArgumentsError)
    try {
      thrown()
    } catch (error) {
      expect(error).toMatchObject({
        argumentProblem: { agent: 'Codex', option, problem }
      })
      expect(JSON.stringify(error)).not.toContain('secret')
      expect(JSON.stringify(error)).not.toContain('private')
    }
  })
})
