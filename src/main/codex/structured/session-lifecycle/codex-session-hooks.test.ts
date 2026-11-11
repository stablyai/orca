import { expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { optionSession } from '../catalog/codex-structured-option-session.test-fixture'
import {
  resolveCodexHomeProcessLockKey,
  withCodexHomeProcessLock
} from '../../../codex-cli/codex-home-process-lock'
import { reviewCodexSessionHooks } from './codex-session-hooks'

const record = agentSessionRecordFixture({
  sessionId: 'hooks-session',
  provider: 'codex',
  accountHome: { variable: 'CODEX_HOME', path: '/home/hooks-review/.codex' }
})

it('returns an abort while queued and never executes the abandoned review after the lock releases', async () => {
  const release = Promise.withResolvers<void>()
  const acquired = Promise.withResolvers<void>()
  const lock = withCodexHomeProcessLock(
    resolveCodexHomeProcessLockKey('/home/hooks-review/.codex'),
    async () => {
      acquired.resolve()
      await release.promise
    }
  )
  await acquired.promise
  let invoked = false
  const review = reviewCodexSessionHooks(new Map(), () => {
    invoked = true
    return undefined
  })
  const abort = new AbortController()
  const pending = review(record, undefined, abort.signal)
  abort.abort(new Error('Review timed out'))
  try {
    await expect(pending).rejects.toThrow('Review timed out')
  } finally {
    release.resolve()
    await lock
  }
  await withCodexHomeProcessLock(
    resolveCodexHomeProcessLockKey('/home/hooks-review/.codex'),
    async () => {}
  )
  expect(invoked).toBe(false)
})

it('rejects trust reviewed on a different host instance even when session, home, cwd and hash match', async () => {
  let written = false
  const session = optionSession(async (method) => {
    if (method === 'config/batchWrite') {
      written = true
    }
    return {
      data: [
        {
          cwd: '/workspace',
          errors: [],
          warnings: [],
          hooks: [
            {
              key: 'hook',
              currentHash: 'same-hash',
              handlerType: 'command',
              command: 'printf hook',
              eventName: 'preToolUse',
              source: 'user',
              sourcePath: '/home/hooks-review/.codex/hooks.json',
              enabled: true,
              isManaged: false,
              trustStatus: 'untrusted',
              timeoutSec: 10
            }
          ]
        }
      ]
    }
  })
  session.codexHome = '/home/hooks-review/.codex'
  session.permissions = { acquiredMode: 'ask', launchSandboxIntact: true, cwd: '/workspace' }
  const sessions = new Map([[record.sessionId, session]])
  const original = reviewCodexSessionHooks(sessions, () => undefined)
  const replacement = reviewCodexSessionHooks(sessions, () => undefined)
  const signal = new AbortController().signal
  const displayed = await original(record, undefined, signal)
  await expect(
    replacement(record, { scope: displayed.scope, key: 'hook', currentHash: 'same-hash' }, signal)
  ).rejects.toThrow('The hook or chat changed')
  expect(written).toBe(false)
})
