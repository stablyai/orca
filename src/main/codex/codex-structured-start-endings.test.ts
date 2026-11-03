import { expect, it } from 'vitest'
import { CodexAppServerExitError } from './app-server/codex-app-server-exit-error'
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
