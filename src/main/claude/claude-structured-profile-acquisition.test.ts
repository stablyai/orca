import { expect, it, vi } from 'vitest'
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

it('releases common profile preparation when cancellation overtakes launch resolution', async () => {
  const entered = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<ClaudeStructuredLaunch>()
  const release = vi.fn()
  const claude = fakeClaude()
  const adapter = new ClaudeStructuredSessionAdapter({
    hasProfileBinding: () => true,
    resolveLaunch: () => {
      entered.resolve()
      return pending.promise
    },
    openConnection: claude.openConnection
  })
  const acquiring = adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'profile-cancel'
  })
  await entered.promise
  const closing = adapter.closeAll()
  pending.resolve({
    pathToClaudeCodeExecutable: '/trusted/claude',
    options: {},
    cwd: '/work',
    claudeConfigDir: '/profile/home',
    providerSessionId: PROVIDER_SESSION_ID,
    resumeLeafUuid: null,
    resumesTranscript: false,
    continuesChain: false,
    release
  })
  await expect(acquiring).rejects.toThrow(/superseded|cancelled/)
  await closing
  expect(release).toHaveBeenCalledTimes(1)
  expect(claude.connections).toHaveLength(0)
})
