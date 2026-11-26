import { describe, expect, it } from 'vitest'
import { generateBranchNameFromContext } from '../commit-message-text-generation'

describe('generateBranchNameFromContext', () => {
  it('keeps a Chinese workspace title separate from the English Git branch', async () => {
    const result = await generateBranchNameFromContext(
      { firstPrompt: '修复韩语时间输入', workspaceTitleLanguage: '中文（简体）' },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '```json\n{"branch":"Fix/Korean Time Input","title":"修复韩语时间输入"}\n```',
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toEqual({
      success: true,
      slug: 'fix-korean-time-input',
      displayName: '修复韩语时间输入',
      agentLabel: 'agent'
    })
  })

  it('rejects a localized title response without a branch instead of making a title into a Git ref', async () => {
    const result = await generateBranchNameFromContext(
      { firstPrompt: '修复登录', workspaceTitleLanguage: '中文（简体）' },
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      {
        kind: 'remote',
        cwd: '/repo',
        missingBinaryLocation: 'remote PATH',
        execute: async () => ({
          stdout: '{"title":"修复登录"}',
          stderr: '',
          exitCode: 0,
          timedOut: false
        })
      }
    )

    expect(result).toMatchObject({
      success: false,
      error: 'Generated workspace name must be a JSON object with branch and title fields.'
    })
  })

  it.each(['{"branch":"修复登录","title":"修复登录"}', '{"title":"修复登录"}'])(
    'accepts a usable title without a usable branch for title-only requests: %s',
    async (stdout) => {
      const result = await generateBranchNameFromContext(
        {
          firstPrompt: '修复登录',
          workspaceTitleLanguage: '中文（简体）',
          workspaceTitleOnly: true
        },
        { agentId: 'custom', model: '', customAgentCommand: 'agent' },
        {
          kind: 'remote',
          cwd: '/repo',
          missingBinaryLocation: 'remote PATH',
          execute: async () => ({ stdout, stderr: '', exitCode: 0, timedOut: false })
        }
      )

      expect(result).toEqual({
        success: true,
        slug: '',
        displayName: '修复登录',
        agentLabel: 'agent'
      })
    }
  )
})
