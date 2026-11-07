import { describe, expect, it } from 'vitest'
import { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'

function resolveClaudeEnvironment(platform: NodeJS.Platform): Promise<Record<string, string>> {
  return createStructuredAgentEnvironmentResolvers({
    platform,
    resolveEnvironment: async () => ({ TOKEN: 'inherited', KEEP: 'kept' }),
    resolveShellEnvironmentPolicy: () => ({ inheritAll: true, names: [] }),
    resolveAgentLaunchEnv: () => ({ tOKEN: 'configured' })
  }).resolveAgentEnvironment('claude')
}

describe('agent launch environment overlay', () => {
  it('replaces a differently cased inherited variable on Windows', async () => {
    expect(await resolveClaudeEnvironment('win32')).toEqual({ KEEP: 'kept', tOKEN: 'configured' })
  })

  it('keeps case-distinct variables apart on POSIX', async () => {
    expect(await resolveClaudeEnvironment('linux')).toEqual({
      KEEP: 'kept',
      TOKEN: 'inherited',
      tOKEN: 'configured'
    })
  })
})
