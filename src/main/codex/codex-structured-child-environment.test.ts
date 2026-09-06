import { describe, expect, it } from 'vitest'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import { buildCodexStructuredChildEnvironment } from './codex-structured-child-environment'

describe('buildCodexStructuredChildEnvironment', () => {
  it('keeps shell exports while pinned launch values win', () => {
    expect(
      buildCodexStructuredChildEnvironment(
        {
          command: 'codex',
          args: ['app-server'],
          cwd: '/worktree',
          codexHome: '/pinned/home',
          resumeThreadId: null,
          env: { EXAMPLE_GATEWAY_TOKEN: 'shell-exported', CODEX_HOME: '/shell/home' }
        },
        'spawn-token'
      )
    ).toEqual({
      EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
      CODEX_HOME: '/pinned/home',
      [CODEX_SPAWN_TOKEN_ENV]: 'spawn-token'
    })
  })
})
