import { expect, it } from 'vitest'
import { adoptedHistoryChat } from './structured-agent-session-history-refresh.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data.test-fixture'
import { stopCreatedChat } from './structured-agent-session-create.test-fixture'
import {
  REST_TEST_CALLER,
  restTestSend,
  collectSubscriber,
  readerSaw
} from './structured-agent-session-rest-test-rig.test-fixture'
import { refreshCodexSessionHistory } from '../../../../codex/structured/session-lifecycle/codex-session-history-refresh'

it.each(['close', 'cancel', 'dispose', 'send'] as const)(
  'retires a blocked refresh on %s and rejects late history',
  async (action) => {
    const { rig, source, append, prompts, drained } = await adoptedHistoryChat()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const returned = Promise.withResolvers<void>()
    try {
      await append(1)
      source.beforeFullRead = async () => {
        entered.resolve()
        await release.promise
        returned.resolve()
      }
      expect((await rig.host.revealSession(SESSION)).readable).toBe(true)
      await entered.promise
      await Promise.all([rig.host.revealSession(SESSION), rig.host.revealSession(SESSION)])
      expect(source.calls).toBe(1)
      expect(await prompts()).toEqual(['synthetic prompt 0'])
      if (action === 'close') {
        await rig.host.close(SESSION, 'user-close')
      } else if (action === 'cancel') {
        expect((await stopCreatedChat(rig.host, SESSION, 1)).ok).toBe(true)
      } else if (action === 'dispose') {
        await rig.restart({ adapter: rig.host.deps.adapter })
      } else {
        expect(
          (await rig.host.send(REST_TEST_CALLER, restTestSend('local concurrent', 1))).ok
        ).toBe(true)
      }
      await drained()
      expect(rig.host.collaboratorsForTests().runtimeState.acquireAborts.has(SESSION)).toBe(false)
      release.resolve()
      await returned.promise
      await drained()
      expect(await prompts()).toEqual(
        action === 'send' ? ['synthetic prompt 0', 'local concurrent'] : ['synthetic prompt 0']
      )
    } finally {
      release.resolve()
      await rig.dispose()
    }
  }
)

it('preserves a local submission admitted before the provider captures its journal view', async () => {
  const { rig, append, refresh, prompts } = await adoptedHistoryChat()
  try {
    await append(1)
    const { journal } = await rig.host.conversation(SESSION)
    const readHistory = rig.host.deps.adapter.refreshHistory!
    rig.host.deps.adapter.refreshHistory = async (input) => {
      await journal.write({
        kind: 'submission',
        input: {
          clientMessageId: 'late-local',
          payloadFingerprint: 'late-local',
          body: hostTestMessage('local pending'),
          fence: 1
        }
      })
      await readHistory(input)
    }
    await refresh()
    expect(await prompts()).toEqual(['synthetic prompt 0', 'local pending'])
    expect(
      (await journal.reads.input({ kind: 'unsettled-submissions' })).submissions.map(
        (row) => row.clientMessageId
      )
    ).toEqual(['late-local'])
  } finally {
    await rig.dispose()
  }
})

it('publishes refreshed journal rows to an already attached reader', async () => {
  const { rig, append, refresh } = await adoptedHistoryChat()
  const subscriber = collectSubscriber()
  const observed = Promise.withResolvers<void>()
  try {
    await rig.host.subscribe({
      id: 'history-reader',
      sessionId: SESSION,
      emit: (event) => {
        subscriber.emit(event)
        if (readerSaw(subscriber.events).texts.includes('synthetic answer 1')) {
          observed.resolve()
        }
      }
    })
    await append(1)
    await refresh()
    await observed.promise
    expect(readerSaw(subscriber.events).texts).toContain('synthetic prompt 1')
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  } finally {
    await rig.dispose()
  }
})

it('cancels the production adapter while environment resolution is blocked, without resolving a binary', async () => {
  const { rig, drained, prompts } = await adoptedHistoryChat()
  const entered = Promise.withResolvers<void>()
  const environment = Promise.withResolvers<NodeJS.ProcessEnv>()
  let resolvedCommand = false
  try {
    rig.host.deps.adapter.refreshHistory = (input) =>
      refreshCodexSessionHistory(input, {
        resolveWorkspacePath: async () => rig.root,
        resolveLaunchArgs: () => [],
        resolveEnvironment: () => {
          entered.resolve()
          return environment.promise
        },
        resolveCommand: () => {
          resolvedCommand = true
          throw new Error('a cancelled probe must not resolve a command')
        }
      })
    await rig.host.revealSession(SESSION)
    await entered.promise
    await rig.host.close(SESSION, 'user-close')
    await drained()
    environment.resolve({ HOME: rig.root, PATH: '' })
    expect(resolvedCommand).toBe(false)
    expect(await prompts()).toEqual(['synthetic prompt 0'])
  } finally {
    environment.resolve({ HOME: rig.root, PATH: '' })
    await rig.dispose()
  }
})
