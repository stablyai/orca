// What the registry does when it retires a session ITSELF — a switch-adoption
// conflict, or an identity it could not read back — rather than being asked to
// release one. Split from omp-rpc-chat-session-registry.test.ts so neither file
// exceeds its max-lines budget.

import { afterEach, describe, expect, it } from 'vitest'
import type { OmpRpcClientEvent, OmpSessionOwningRpcClient } from '../../shared/omp-rpc-protocol'
import { createFakeOmpRpcChild } from './fake-omp-rpc-child'
import { spawnOmpRpcClient } from './omp-rpc-client'
import { OmpRpcChatSessionRegistry } from './omp-rpc-chat-session-registry'

const clients = new Set<OmpSessionOwningRpcClient>()

function makeRegistry(
  scenario: Partial<Parameters<typeof createFakeOmpRpcChild>[0]> = {},
  dependencies: Omit<
    NonNullable<ConstructorParameters<typeof OmpRpcChatSessionRegistry>[0]>,
    'spawnClient'
  > = {}
): OmpRpcChatSessionRegistry {
  return new OmpRpcChatSessionRegistry({
    ...dependencies,
    spawnClient: () => {
      const client = spawnOmpRpcClient(
        createFakeOmpRpcChild(
          {
            ...scenario,
            sessionState: {
              sessionFile: null,
              sessionId: 'session-a',
              isStreaming: false,
              isCompacting: false,
              queuedMessageCount: 0
            }
          },
          'session-owning'
        ).spawnOptions
      ) as unknown as OmpSessionOwningRpcClient
      clients.add(client)
      return client
    }
  })
}

/** Pane B owns `/sessions/b.jsonl`; pane A is then acquired on
 *  `/sessions/a.jsonl` and its next command switches it onto B's session. */
async function acquireContestedPanes(registry: OmpRpcChatSessionRegistry): Promise<void> {
  await registry.acquire({
    paneKey: 'tab:leaf-b',
    ptyId: 'pty-b',
    cwd: '/work',
    executablePath: 'omp',
    sessionFile: 'session-b',
    sessionFilePath: '/sessions/b.jsonl',
    isPtyAlive: () => false
  })
  await registry.acquire({
    paneKey: 'tab:leaf-a',
    ptyId: 'pty-a',
    cwd: '/work',
    executablePath: 'omp',
    sessionFile: 'session-a',
    sessionFilePath: '/sessions/a.jsonl',
    isPtyAlive: () => false
  })
}

afterEach(() => {
  for (const client of clients) {
    client.dispose()
  }
  clients.clear()
})

describe('OmpRpcChatSessionRegistry switch-adoption retirement', () => {
  // XLR-030: retirement used to dispose the child and delete the registration
  // in silence. No fatal frame reached the ownership hook, so the renderer
  // stayed 'acquired' and routed sends to a main with no session — on a pane
  // whose PTY acquisition had already killed.
  it('tells the pane its session was retired, over the fatal-frame channel', async () => {
    const registry = makeRegistry({
      promptSessionChange: { sessionFile: '/sessions/b.jsonl', sessionId: 'session-b' }
    })
    await acquireContestedPanes(registry)
    const switched = registry.get('tab:leaf-a')
    const events: OmpRpcClientEvent[] = []
    switched?.on((event) => events.push(event))

    await switched?.send({ message: '/branch', behavior: 'command' })

    expect(registry.get('tab:leaf-a')).toBeNull()
    expect(events.filter((event) => event.kind === 'protocol-fault')).toHaveLength(1)
  })

  // The other half of XLR-030: the hook reacts to that frame by asking for the
  // release that carries the hand-back. With no registration left, the release
  // reported `released: false`, so the IPC layer pushed no hand-back and the
  // pane kept neither a session nor a terminal.
  it('answers the follow-up release as released, so the PTY hand-back is pushed', async () => {
    const registry = makeRegistry({
      promptSessionChange: { sessionFile: '/sessions/b.jsonl', sessionId: 'session-b' }
    })
    await acquireContestedPanes(registry)

    await registry.get('tab:leaf-a')?.send({ message: '/branch', behavior: 'command' })

    // No proven session id: the pane resumes its OWN acquisition-time session,
    // never the contested one pane B still owns.
    expect(await registry.release('tab:leaf-a')).toEqual({ released: true })
    // Granted once. A second release has nothing left to hand back.
    expect(await registry.release('tab:leaf-a')).toEqual({ released: false })
  })

  // XLR-029: release used to race the adoption. It observed the settled child
  // (already switched to B), disposed it, freed A's claim, and returned B as the
  // identity to resume — putting a resumed PTY beside pane B's live RPC child.
  it('waits for an authorized switch to be adopted before handing the pane back', async () => {
    const registry = makeRegistry({
      promptSessionChange: { sessionFile: '/sessions/b.jsonl', sessionId: 'session-b' }
    })
    await acquireContestedPanes(registry)
    const switched = registry.get('tab:leaf-a')

    const send = switched?.send({ message: '/branch', behavior: 'command' })
    const released = registry.release('tab:leaf-a')
    await send

    expect(await released).toEqual({ released: true })
    // Pane B keeps the contested session, and the abandoned one stops being
    // excluded from every other pane.
    expect(registry.claimedSessionFilePathsExcluding('tab:leaf-other')).toEqual(
      new Set(['/sessions/b.jsonl'])
    )
    expect(registry.get('tab:leaf-b')).not.toBeNull()
  })

  // XLR-042 (cross-lab review): the exit proof is a deadline, and a
  // SIGTERM-delayed child routinely outlives it. Retirement had already
  // forgotten the session by then, so the late exit could free the low-level
  // claim (XLR-040) and nothing else — the pane's session-file exclusion
  // outlived the child it was protecting, and the hand-back obligation, which
  // is all `release` has left to answer with once the registration is gone, was
  // never established. Every later release reported `released: false`, and no
  // other pane could resolve that session again until app restart.
  it('finishes an unreadable retirement once its child is finally seen to exit (XLR-042)', async () => {
    const registry = makeRegistry(
      { promptSessionChange: { sessionFile: null } },
      { proveRpcExit: async () => ({ status: 'unverifiable', reason: 'child exit unproven' }) }
    )
    await registry.acquire({
      paneKey: 'tab:leaf-a',
      ptyId: 'pty-a',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: 'session-a',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const retired = registry.get('tab:leaf-a')

    await retired?.send({ message: '/branch', behavior: 'command' })

    // Nothing is freed on the SIGTERM alone: an unreadable identity is no proof
    // the child left the session it acquired (XLR-036).
    expect(registry.get('tab:leaf-a')).toBeNull()
    expect(registry.claimedSessionFilePathsExcluding('other:pane')).toEqual(
      new Set(['/sessions/a.jsonl'])
    )

    await retired?.owned.client.whenExited()

    expect(registry.claimedSessionFilePathsExcluding('other:pane')).toEqual(new Set())
    // Acquisition killed this pane's PTY, and `released: true` is the only
    // answer that makes the IPC layer push the hand-back that brings it back.
    expect(await registry.release('tab:leaf-a')).toEqual({ released: true })
    const reacquired = await registry.acquire({
      paneKey: 'other:pane',
      ptyId: 'pty-b',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: 'session-a',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(reacquired.status).toBe('acquired')
  })

  // XLR-R6-002 (cross-lab review): the retirement above emits a fatal frame,
  // and the renderer answers it with its ONE release request — which arrives
  // before the child's exit is provable, so it is refused. When the exit lands
  // later, the owed hand-back was recorded with nobody told, and the pane sat
  // faulted with neither RPC ownership nor a PTY. The late exit must carry the
  // same notification a failed acquisition's does.
  it('tells the pane its hand-back is owed once a retired child exits (XLR-R6-002)', async () => {
    const registry = makeRegistry(
      { promptSessionChange: { sessionFile: null } },
      { proveRpcExit: async () => ({ status: 'unverifiable', reason: 'child exit unproven' }) }
    )
    let lateExitNotices = 0
    await registry.acquire({
      paneKey: 'tab:leaf-a',
      ptyId: 'pty-a',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: 'session-a',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false,
      onLateRpcChildExit: () => {
        lateExitNotices += 1
      }
    })
    const retired = registry.get('tab:leaf-a')

    await retired?.send({ message: '/branch', behavior: 'command' })
    // The pane's one release, fired off the fatal frame, is refused: nothing is
    // registered and no hand-back is owed yet.
    expect(await registry.release('tab:leaf-a')).toEqual({ released: false })
    expect(lateExitNotices).toBe(0)

    await retired?.owned.client.whenExited()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(lateExitNotices).toBe(1)
    expect(await registry.release('tab:leaf-a')).toEqual({ released: true })
  })

  // XLR-048 (cross-lab review): the late cleanup a retirement schedules used to
  // be fenced on the newest acquire ATTEMPT's generation. An attempt bumps that
  // generation before it can fail, so a failed retry suppressed the cleanup
  // outright — the retired path stayed excluded from every pane for the app's
  // life even though its claim had been released, and the hand-back the pane
  // was owed was never recorded. Only a registered replacement owner may
  // silence it.
  it('still settles a retirement whose later acquire attempt failed to replace it (XLR-048)', async () => {
    const registry = makeRegistry(
      { promptSessionChange: { sessionFile: null } },
      { proveRpcExit: async () => ({ status: 'unverifiable', reason: 'child exit unproven' }) }
    )
    await registry.acquire({
      paneKey: 'tab:leaf-a',
      ptyId: 'pty-a',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const retiring = registry.get('tab:leaf-a')?.owned
    await expect(
      registry.get('tab:leaf-a')?.send({ message: '/branch', behavior: 'command' })
    ).resolves.toMatchObject({ ok: false })
    expect(registry.get('tab:leaf-a')).toBeNull()

    // A retry for the same pane: it bumps the acquire generation and then
    // fails, installing no replacement owner.
    const retry = await registry.acquire({
      paneKey: 'tab:leaf-a',
      ptyId: 'pty-a',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => true
    })
    expect(retry.status).toBe('live')

    await retiring?.client.whenExited()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(registry.claimedSessionFilePathsExcluding('other:pane')).not.toContain(
      '/sessions/a.jsonl'
    )
    expect(await registry.release('tab:leaf-a')).toEqual({ released: true })
  })
})
