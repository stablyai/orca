import { expect, it } from 'vitest'
import { CodexAppServerExitError } from '../../app-server/codex-app-server-exit-error'
import { claudeAndCodexRouter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'
import { adapterFor, fakeCodex, identityFor } from './codex-structured-session-adapter-fixture'

it("keeps a start's ending only while that start can still read it", async () => {
  const codex = fakeCodex()
  const adapter = adapterFor(codex)
  const exit = () =>
    codex.connections
      .at(-1)!
      .handlers.onExit?.(new CodexAppServerExitError('codex app-server connection ended'), {
        expected: false
      })
  const acquire = async (id: string) => {
    const acquired = await adapter.acquire({
      identity: identityFor(id),
      fence: 1,
      spawnToken: `spawn-${id}`
    })
    return { id, generation: acquired.acquisitionGeneration }
  }
  const retained = (starts: { id: string; generation: string }[]) =>
    starts.filter(({ id, generation }) => adapter.startupEnding(id, generation))

  // Each start's own exit is readable until its owner is done, it is released, or it is closed.
  const ended: { id: string; generation: string }[] = []
  for (const id of ['owner-done', 'released', 'closed']) {
    ended.push(await acquire(id))
    codex.connections.at(-1)!.closed = true
    exit()
  }
  expect(retained(ended)).toHaveLength(3)
  adapter.retireStartup(ended[0].id, ended[0].generation)
  await adapter.releaseAcquisition({ sessionId: ended[1].id })
  await adapter.disposeSession(ended[2].id)
  expect(retained(ended)).toEqual([])

  // A start its owner made ready leaves nothing behind when it later exits.
  const ready = await acquire('ready')
  adapter.retireStartup(ready.id, ready.generation)
  codex.connections.at(-1)!.closed = true
  exit()
  expect(retained([ready])).toEqual([])
  await adapter.closeAll()
})

it("keeps a routed start's ending until its owner retires it, after exit dropped the route", async () => {
  const codex = fakeCodex()
  const adapter = adapterFor(codex)
  const router = claudeAndCodexRouter({ claude: adapterFor(fakeCodex()), codex: adapter }, () =>
    adapter.closeAll()
  )
  const exitLatest = () => {
    const connection = codex.connections.at(-1)!
    connection.closed = true
    const exit = () =>
      connection.handlers.onExit?.(
        new CodexAppServerExitError('codex app-server connection ended'),
        {
          expected: false
        }
      )
    exit()
    return exit
  }
  const starts: { id: string; generation: string }[] = []
  for (let n = 0; n < 10; n++) {
    const id = `routed-${n}`
    const acquired = await router.acquire({
      identity: identityFor(id),
      fence: 1,
      spawnToken: `s-${n}`
    })
    exitLatest()
    // The host acknowledges the exit before the start's owner has finished reading it.
    router.acknowledgeSessionRelease(id)
    expect(router.startupEnding(id, acquired.acquisitionGeneration)).toBeDefined()
    router.retireStartup(id, acquired.acquisitionGeneration)
    starts.push({ id, generation: acquired.acquisitionGeneration })
  }
  expect(starts.filter(({ id, generation }) => adapter.startupEnding(id, generation))).toEqual([])

  // An old owner's retirement leaves the replacement's ending, and a late old exit records nothing.
  const old = await router.acquire({
    identity: identityFor('replaced'),
    fence: 1,
    spawnToken: 'r-1'
  })
  const lateOldExit = exitLatest()
  router.acknowledgeSessionRelease('replaced')
  const next = await router.acquire({
    identity: identityFor('replaced'),
    fence: 2,
    spawnToken: 'r-2'
  })
  exitLatest()
  router.retireStartup('replaced', old.acquisitionGeneration)
  expect(router.startupEnding('replaced', next.acquisitionGeneration)).toBeDefined()
  lateOldExit()
  expect(router.startupEnding('replaced', old.acquisitionGeneration)).toBeUndefined()
  await adapter.closeAll()
})
