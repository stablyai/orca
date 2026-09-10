import { afterEach, describe, expect, it } from 'vitest'
import type { OmpRpcBaseSpawnOptions, OmpSessionOwningRpcClient } from '../../shared/omp-rpc-protocol'
import { createFakeOmpRpcChild } from './fake-omp-rpc-child'
import { spawnOmpRpcClient } from './omp-rpc-client'
import { OmpRpcChatSessionRegistry } from './omp-rpc-chat-session-registry'

const clients = new Set<OmpSessionOwningRpcClient>()

function makeRegistry(
  scenario: Partial<Parameters<typeof createFakeOmpRpcChild>[0]> = {},
  dependencies: Omit<
    NonNullable<ConstructorParameters<typeof OmpRpcChatSessionRegistry>[0]>,
    'spawnClient'
  > = {},
  onSpawn?: (options: OmpRpcBaseSpawnOptions & { sessionMode: 'session-owning' }) => void
): OmpRpcChatSessionRegistry {
  return new OmpRpcChatSessionRegistry({
    ...dependencies,
    spawnClient: (options) => {
      onSpawn?.(options)
      const client = spawnOmpRpcClient(
        createFakeOmpRpcChild(
          {
            ...scenario,
            sessionState: {
              sessionFile: null,
              // Why: a real OMP RPC child always reports a sessionId once
              // acquired (Decision 2 in docs/omp-rpc-chat-adapter-plan.md —
              // it is the claim identity) — this fixture is left non-null
              // so `release()` genuinely reaches handoffToPty's 'exited'
              // path instead of short-circuiting on 'ownership-unknown'
              // (a wrong-shaped fixture would silently mask that path).
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

afterEach(() => {
  for (const client of clients) {
    client.dispose()
  }
  clients.clear()
})

describe('OmpRpcChatSessionRegistry', () => {
  it('fails closed with status "live" without spawning when the pty is still running', async () => {
    let spawned = false
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        spawned = true
        throw new Error('must not spawn')
      }
    })
    const result = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => true
    })
    expect(result.status).toBe('live')
    expect(spawned).toBe(false)
  })

  it('fails closed with "unverifiable" when pty liveness cannot be determined', async () => {
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        throw new Error('must not spawn')
      }
    })
    const result = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => null
    })
    expect(result.status).toBe('unverifiable')
  })

  it('acquires an RPC session once the pty is confirmed exited', async () => {
    const registry = makeRegistry()
    const result = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(result.status).toBe('acquired')
    if (result.status === 'acquired') {
      expect(registry.get('tab:leaf')).toBe(result.session)
    }
  })

  it('forwards configured command arguments into the session-owning RPC launch', async () => {
    const spawnOptions: (OmpRpcBaseSpawnOptions & { sessionMode: 'session-owning' })[] = []
    const registry = makeRegistry({}, {}, (options) => spawnOptions.push(options))

    await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'env',
      commandArgs: ['omp', '--profile', 'work'],
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    } as Parameters<OmpRpcChatSessionRegistry['acquire']>[0])

    expect(spawnOptions).toEqual([
      expect.objectContaining({
        executablePath: 'env',
        commandArgs: ['omp', '--profile', 'work']
      })
    ])
  })

  it('returns the same session on a repeated acquire for the same pane', async () => {
    const registry = makeRegistry()
    const first = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const second = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(first.status).toBe('acquired')
    expect(second.status).toBe('acquired')
    if (first.status === 'acquired' && second.status === 'acquired') {
      expect(second.session).toBe(first.session)
    }
  })

  it('recognizes renderer adoption only for the session the pane owns', async () => {
    const registry = makeRegistry()
    await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: 'session-a',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })

    expect(registry.getSessionFile('tab:leaf')).toBe('session-a')
    expect(registry.getSessionFile('tab:other')).toBeNull()
  })

  it('releases a session and frees the pane for a fresh acquisition', async () => {
    const registry = makeRegistry()
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')

    const released = await registry.release('tab:leaf')
    expect(released.released).toBe(true)
    expect(registry.get('tab:leaf')).toBeNull()

    const reacquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(reacquired.status).toBe('acquired')
  })

  it('releasing an unknown pane is a no-op', async () => {
    const registry = makeRegistry()
    await expect(registry.release('unknown:pane')).resolves.toEqual({ released: false })
  })

  it('reports spawn failure without acquiring when the child cannot start', async () => {
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        throw new Error('spawn exploded')
      }
    })
    const result = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'does-not-exist',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(result.status).toBe('spawn-failed')
  })

  // XLR-038 (cross-lab review): an initialization that failed AFTER the child
  // was spawned is not "nothing started". When cleanup cannot prove that child
  // exited, reporting `spawn-failed` reads to the renderer as proof the session
  // is free — `recoverPtyAfterRefusedOmpRpcAcquire` then respawns `omp
  // --resume` beside a child that may still be writing it. Only the cleanup's
  // own unproven verdict excludes that respawn.
  //
  // Under its OWN status, never the PTY's `unverifiable` (XLR-041): `pty-1` is
  // provably exited here — that proof is what admitted the spawn — so borrowing
  // the verdict that means "this pane's PTY may still be alive" made the
  // renderer disarm its exit suppression and rebind the pane to the terminal it
  // had just killed, leaving it bound to a dead process while a later RPC-child
  // exit released only the claim.
  it('reports an unprovable child exit after a failed switch under its own status (XLR-038/XLR-041)', async () => {
    const registry = makeRegistry(
      { exitOnCommand: 'switch_session' },
      { proveRpcExit: async () => ({ status: 'unverifiable', reason: 'child exit unproven' }) }
    )
    const result = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(result).toEqual({ status: 'rpc-child-unverifiable', reason: 'child exit unproven' })
  })

  // F4 (HIGH): app quit must kill every RPC child and release its claim, not
  // just tear down local listeners — otherwise a quit mid-turn orphans the
  // child and a relaunched PTY resume becomes a second writer on the session.
  it('disposeAll kills every RPC child and releases its claim so the identity can be re-acquired (F4)', async () => {
    const registry = makeRegistry()
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')

    await registry.disposeAll()
    expect(registry.get('tab:leaf')).toBeNull()

    // The claim must be released too — a fresh acquire for the same identity
    // must succeed outright, not conflict with the disposed session's claim.
    const reacquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(reacquired.status).toBe('acquired')
  })

  // F5 (HIGH): release deletes the pane entry synchronously but holds the
  // claim until its handoff settles — acquire must wait for any in-flight
  // release for the same pane instead of racing it into a spurious conflict.
  it('acquire waits for an in-flight release before re-acquiring the same pane (F5)', async () => {
    const registry = makeRegistry()
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')

    const releasePromise = registry.release('tab:leaf')
    const reacquirePromise = registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const [releaseResult, reacquireResult] = await Promise.all([releasePromise, reacquirePromise])
    expect(releaseResult.released).toBe(true)
    expect(reacquireResult.status).toBe('acquired')
  })

  // F5: React StrictMode double-mounts fire two concurrent acquires for the
  // same identity — the second must reuse the first's in-flight result
  // instead of racing a second spawn into `agent_session_conflict`.
  it('reuses an in-flight acquire for the same identity instead of double-spawning (F5)', async () => {
    const registry = makeRegistry()
    const args = {
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    }
    const [first, second] = await Promise.all([registry.acquire(args), registry.acquire(args)])
    expect(first.status).toBe('acquired')
    expect(second.status).toBe('acquired')
    if (first.status === 'acquired' && second.status === 'acquired') {
      expect(second.session).toBe(first.session)
    }
  })

  // XLR-013 (cross-lab review): the renderer's acquisition identity is
  // paneKey + cwd + sessionFile, so a pending acquire may only be shared with a
  // request that matches all three -- a joined promise hands back a child
  // spawned in the OLD working directory.
  it('never joins a pending acquire that was spawned for a different cwd (XLR-013)', async () => {
    const spawnedCwds: (string | undefined)[] = []
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: (options) => {
        spawnedCwds.push(options.cwd)
        const client = spawnOmpRpcClient(
          createFakeOmpRpcChild(
            {
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
    const base = {
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    }
    const [stale, fresh] = await Promise.all([
      registry.acquire({ ...base, cwd: '/work/a' }),
      registry.acquire({ ...base, cwd: '/work/b' })
    ])

    // The child already spawned for /work/a is the pane's SUPERSEDED identity,
    // so it can never answer the /work/b request: the single-writer claim
    // refuses a second child on the same session file, and the first disposes
    // itself as superseded. Both requests fail closed on `conflict`, which the
    // renderer retries -- the one outcome that must never happen is the /work/a
    // child being published as the /work/b acquisition.
    expect(stale.status).toBe('conflict')
    expect(fresh.status).toBe('conflict')
    expect(registry.get('tab:leaf')).toBeNull()
    expect(spawnedCwds).toEqual(['/work/a'])
  })

  // F5 (cross-lab HIGH_2): a slower acquire for an identity that was rebound
  // mid-flight (not just released) must lose to the newer one — dispose
  // itself and never overwrite the paneKey's newer session.
  it('a stale acquire for a superseded identity disposes itself and never overwrites the newer session (F5)', async () => {
    const registry = makeRegistry()
    const stalePromise = registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const freshPromise = registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/b.jsonl',
      sessionFilePath: '/sessions/b.jsonl',
      isPtyAlive: () => false
    })
    const [stale, fresh] = await Promise.all([stalePromise, freshPromise])
    expect(stale.status).toBe('conflict')
    expect(fresh.status).toBe('acquired')
    if (fresh.status === 'acquired') {
      expect(registry.get('tab:leaf')).toBe(fresh.session)
    }
  })

  // XLR-018 (cross-lab review): a supported command can move the child to
  // another session, and upstream announces nothing. Left unread, this pane
  // keeps excluding the session it acquired while the live one stays unclaimed
  // — so a second pane sharing the cwd bucket can be handed it, producing two
  // writers on one session file.
  it('follows the child onto the session a command switched it to', async () => {
    const registry = makeRegistry({
      promptSessionChange: { sessionFile: '/sessions/b.jsonl', sessionId: 'session-b' }
    })
    await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(registry.claimedSessionFilePathsExcluding('other:pane')).toEqual(
      new Set(['/sessions/a.jsonl'])
    )

    await registry.get('tab:leaf')?.send({ message: '/branch', behavior: 'command' })

    expect(registry.claimedSessionFilePathsExcluding('other:pane')).toEqual(
      new Set(['/sessions/b.jsonl'])
    )
    // XLR-019: the release now reports the identity main proved, which is the
    // switched one — not the id the pane acquired.
    await expect(registry.release('tab:leaf')).resolves.toEqual({
      released: true,
      sessionId: 'session-b'
    })
  })

  it('transfers the execution claim to a command-switched session', async () => {
    const registry = makeRegistry({
      promptSessionChange: { sessionFile: '/sessions/b.jsonl', sessionId: 'session-b' }
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

    await registry.get('tab:leaf-a')?.send({ message: '/branch', behavior: 'command' })

    const oldSession = await registry.acquire({
      paneKey: 'tab:leaf-old',
      ptyId: 'pty-old',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: 'session-a',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const switchedSession = await registry.acquire({
      paneKey: 'tab:leaf-switched',
      ptyId: 'pty-switched',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: 'session-b',
      sessionFilePath: '/sessions/b.jsonl',
      isPtyAlive: () => false
    })

    expect(oldSession.status).toBe('acquired')
    expect(switchedSession.status).toBe('conflict')
  })

  // XLR-024 (cross-lab review): OMP has already moved the child by the time
  // adoption runs, so refusing the switch is not enough — the child is writing
  // a session another pane owns RIGHT NOW, and leaving it alive keeps two
  // writers on it while this pane goes on claiming (and excluding from every
  // other pane) the session it abandoned. The switched child is stopped.
  it('stops the child a command switched onto a session another pane owns', async () => {
    const registry = makeRegistry({
      promptSessionChange: { sessionFile: '/sessions/b.jsonl', sessionId: 'session-b' }
    })
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
    const switched = registry.get('tab:leaf-a')

    await switched?.send({ message: '/branch', behavior: 'command' })

    // Only pane B's own claim survives: the abandoned session stops being
    // excluded, and the contested one keeps exactly one writer.
    expect(registry.claimedSessionFilePathsExcluding('tab:leaf-other')).toEqual(
      new Set(['/sessions/b.jsonl'])
    )
    expect(registry.get('tab:leaf-a')).toBeNull()
    expect(registry.get('tab:leaf-b')).not.toBeNull()
    // The retired child cannot write again — the transport is gone, not just
    // deregistered.
    await expect(switched?.send({ message: 'hello', behavior: 'idle' })).resolves.toMatchObject({
      ok: false
    })
  })

  // F10 (LOW): the dead resume-launch fields must stay gone — nothing a future
  // reader could mistake for a wired PTY-resume path. `sessionId` is the one
  // identity that DOES have a consumer (XLR-019: the hand-back push resumes it),
  // and it is proven by main rather than echoed from the renderer.
  it('release result carries released plus the proven session id, and no resume-launch fields (F10)', async () => {
    const registry = makeRegistry()
    await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const released = await registry.release('tab:leaf')
    expect(released).toEqual({ released: true, sessionId: 'session-a' })
    expect(Object.keys(released).sort()).toEqual(['released', 'sessionId'])
  })

  // Critical B (cross-lab review, wave 5): a release whose turn never
  // settles must fail closed — keep the session registered and never
  // dispose/force-release the claim out from under still-streaming work
  // (the OLD code unconditionally disposed and returned `released: true`
  // here regardless of what handoffToPty reported).
  it('fails closed and keeps the session when the turn never settles (Critical B)', async () => {
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        const client = spawnOmpRpcClient(
          createFakeOmpRpcChild(
            {
              sessionState: {
                sessionFile: null,
                sessionId: 'session-a',
                isStreaming: true,
                isCompacting: false,
                queuedMessageCount: 0
              }
            },
            'session-owning'
          ).spawnOptions
        ) as unknown as OmpSessionOwningRpcClient
        clients.add(client)
        return client
      },
      waitForSettle: async () => ({
        status: 'unverifiable',
        cause: 'timeout',
        reason: 'OMP RPC session did not settle before timeout'
      })
    })
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')

    const released = await registry.release('tab:leaf')

    expect(released).toEqual({ released: false })
    expect(registry.get('tab:leaf')).not.toBeNull()
  })

  // XLR-004 (cross-lab review): the fail-closed release above leaves the old
  // session registered under this paneKey. If the pane has since rebound to
  // a DIFFERENT session, returning the stale one as `acquired` labels the
  // renderer's generation with the new identity while history, prompts and
  // commands all keep going to the old child.
  it('refuses to hand back a registered session whose identity no longer matches the request', async () => {
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        const client = spawnOmpRpcClient(
          createFakeOmpRpcChild(
            {
              sessionState: {
                sessionFile: null,
                sessionId: 'session-a',
                isStreaming: true,
                isCompacting: false,
                queuedMessageCount: 0
              }
            },
            'session-owning'
          ).spawnOptions
        ) as unknown as OmpSessionOwningRpcClient
        clients.add(client)
        return client
      },
      waitForSettle: async () => ({
        status: 'unverifiable',
        cause: 'timeout',
        reason: 'OMP RPC session did not settle before timeout'
      })
    })
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')
    expect(await registry.release('tab:leaf')).toEqual({ released: false })

    const rebound = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-2',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/b.jsonl',
      sessionFilePath: '/sessions/b.jsonl',
      isPtyAlive: () => false
    })

    expect(rebound).toEqual({ status: 'conflict' })
    // The unmatched request must not have adopted session A's registration.
    expect(registry.claimedSessionFilePathsExcluding('other:pane')).toEqual(
      new Set(['/sessions/a.jsonl'])
    )
  })

  // XLR-014 (cross-lab review): the destroyed effect behind a refused release
  // has no retry owner, so the acquire that the rebind produced is the last
  // owner able to retire the stale claim. Once the old child has finished, the
  // pane must be able to take its new session instead of conflicting forever.
  it('reclaims a stale registration once the old child can be released (XLR-014)', async () => {
    let exitProvable = false
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        const client = spawnOmpRpcClient(
          createFakeOmpRpcChild(
            {
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
      },
      proveRpcExit: async () =>
        exitProvable
          ? { status: 'exited' }
          : { status: 'unverifiable', reason: 'child exit could not be proven' }
    })
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')
    // Fails closed and keeps the claim -- and the renderer effect that asked
    // for this release is destroyed by the same rebind that produced the
    // acquire below, so nothing else is left to retry it.
    expect(await registry.release('tab:leaf')).toEqual({ released: false })

    exitProvable = true
    const rebound = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-2',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/b.jsonl',
      sessionFilePath: '/sessions/b.jsonl',
      isPtyAlive: () => false
    })

    expect(rebound.status).toBe('acquired')
    expect(registry.claimedSessionFilePathsExcluding('other:pane')).toEqual(
      new Set(['/sessions/b.jsonl'])
    )
  })

  // XLR-005 (cross-lab review): handoffToPty disposes the child on the
  // strength of a settle observation, and every command surface reaches the
  // child through `get()`. A prompt accepted after that proof but before the
  // dispose would be killed silently, so the whole release window excludes
  // them — and a release that fails closed re-admits them.
  it('excludes command surfaces for the duration of a release, re-admitting them when it fails closed', async () => {
    let observedDuringRelease: unknown = 'not-observed'
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        const client = spawnOmpRpcClient(
          createFakeOmpRpcChild(
            {
              sessionState: {
                sessionFile: null,
                sessionId: 'session-a',
                isStreaming: true,
                isCompacting: false,
                queuedMessageCount: 0
              }
            },
            'session-owning'
          ).spawnOptions
        ) as unknown as OmpSessionOwningRpcClient
        clients.add(client)
        return client
      },
      waitForSettle: async () => {
        observedDuringRelease = registry.get('tab:leaf')
        return {
          status: 'unverifiable',
          cause: 'timeout',
          reason: 'OMP RPC session did not settle before timeout'
        }
      }
    })
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')

    expect(await registry.release('tab:leaf')).toEqual({ released: false })

    expect(observedDuringRelease).toBeNull()
    expect(registry.get('tab:leaf')).not.toBeNull()
  })

  // Lifecycle recovery (phase `pty-hook-lifecycle`): the counterpart to the
  // never-settles test above. A child that already DIED makes every command
  // reject, which used to read as the same "unverifiable" fail-closed
  // outcome — so the pane could never release, its claim and session-file
  // exclusion leaked for the app's life, and (since acquisition kills the
  // PTY) it was left with no terminal and no session. Nothing live is being
  // protected here, so the release must genuinely complete.
  it('releases a pane whose RPC child already died, freeing the claim and its session-file exclusion', async () => {
    const registry = new OmpRpcChatSessionRegistry({
      spawnClient: () => {
        const client = spawnOmpRpcClient(
          createFakeOmpRpcChild(
            {
              sessionState: {
                sessionFile: null,
                sessionId: 'session-a',
                isStreaming: false,
                isCompacting: false,
                queuedMessageCount: 0
              },
              exitOnCommand: 'prompt',
              exitCode: 1
            },
            'session-owning'
          ).spawnOptions
        ) as unknown as OmpSessionOwningRpcClient
        clients.add(client)
        return client
      }
    })
    const acquired = await registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    expect(acquired.status).toBe('acquired')
    const session = registry.get('tab:leaf')
    expect(session).not.toBeNull()

    // Kill the child the way a real crash does: a command it dies on.
    await session?.send({ message: 'hi', behavior: 'idle' })
    await session?.owned.client.whenExited()

    const released = await registry.release('tab:leaf')

    expect(released).toEqual({ released: true })
    expect(registry.get('tab:leaf')).toBeNull()
    // The exclusion set is what keeps a second pane from ever being offered
    // this session again — a leak here outlives the dead child.
    expect(registry.claimedSessionFilePathsExcluding('other:pane')).not.toContain(
      '/sessions/a.jsonl'
    )
  })

  // XLR-035 (cross-lab review): disposing a superseded acquire's child only
  // SIGTERMs it. The claim must still reject another writer while the bounded
  // exit check remains unproven. OmpRpcSessionOwner's controlled-exit tests
  // separately prove that the claim is released only when whenExited resolves.
  it("keeps a superseded acquire's claim through an unproven exit check (XLR-035)", async () => {
    let competingAcquire: ReturnType<OmpRpcChatSessionRegistry['acquire']> | undefined
    let registry!: OmpRpcChatSessionRegistry
    registry = makeRegistry(
      {},
      {
        proveRpcExit: async () => {
          competingAcquire = registry.acquire({
            paneKey: 'other:pane',
            ptyId: 'pty-2',
            cwd: '/work',
            executablePath: 'omp',
            sessionFile: '/sessions/a.jsonl',
            sessionFilePath: '/sessions/a.jsonl',
            isPtyAlive: () => false
          })
          return { status: 'unverifiable', reason: 'child exit unproven' }
        }
      }
    )
    const stalePromise = registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const freshPromise = registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/b.jsonl',
      sessionFilePath: '/sessions/b.jsonl',
      isPtyAlive: () => false
    })
    const [stale, fresh] = await Promise.all([stalePromise, freshPromise])
    expect(stale).toEqual({
      status: 'rpc-child-unverifiable',
      reason: 'superseded OMP RPC child exit unproven'
    })
    expect(fresh.status).toBe('acquired')
    expect(competingAcquire).toBeDefined()
    expect((await competingAcquire)?.status).toBe('conflict')
  })

  it("releases a superseded acquire's writer fence when its child exits late (OMP-RPC-BLOCK-001)", async () => {
    let registry!: OmpRpcChatSessionRegistry
    registry = makeRegistry(
      {},
      {
        proveRpcExit: async () => ({ status: 'unverifiable', reason: 'child exit unproven' })
      }
    )
    const stale = registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/a.jsonl',
      sessionFilePath: '/sessions/a.jsonl',
      isPtyAlive: () => false
    })
    const fresh = registry.acquire({
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      executablePath: 'omp',
      sessionFile: '/sessions/b.jsonl',
      sessionFilePath: '/sessions/b.jsonl',
      isPtyAlive: () => false
    })

    await expect(stale).resolves.toMatchObject({ status: 'rpc-child-unverifiable' })
    await expect(fresh).resolves.toMatchObject({ status: 'acquired' })
    await [...clients].at(0)?.whenExited()

    await expect(
      registry.acquire({
        paneKey: 'other:pane',
        ptyId: 'pty-2',
        cwd: '/work',
        executablePath: 'omp',
        sessionFile: '/sessions/a.jsonl',
        sessionFilePath: '/sessions/a.jsonl',
        isPtyAlive: () => false
      })
    ).resolves.toMatchObject({ status: 'acquired' })
  })
})
