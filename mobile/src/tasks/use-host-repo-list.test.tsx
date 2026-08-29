import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { useHostRepoList, type HostRepoListResource } from './use-host-repo-list'

type Repo = { id: string }

/** Renders the hook and exposes the latest resource plus a deferred fetcher so a
 *  test can decide exactly when (and for which client) a response lands. */
function mountResource() {
  const pending: { resolve: (repos: Repo[]) => void; reject: (err: Error) => void }[] = []
  let latest: HostRepoListResource<Repo> | null = null
  let calls = 0

  function Probe({ clientKey, connected = true }: { clientKey: unknown; connected?: boolean }) {
    latest = useHostRepoList<Repo>(
      clientKey,
      connected
        ? () => {
            calls += 1
            return new Promise<Repo[]>((resolve, reject) => pending.push({ resolve, reject }))
          }
        : null
    )
    return null
  }

  let renderer!: ReturnType<typeof create>
  act(() => {
    renderer = create(createElement(Probe, { clientKey: 'client-a' }))
  })
  return {
    get resource(): HostRepoListResource<Repo> {
      if (!latest) {
        throw new Error('probe never rendered')
      }
      return latest
    },
    get callCount(): number {
      return calls
    },
    pending,
    rerender() {
      act(() => {
        renderer.update(createElement(Probe, { clientKey: 'client-a' }))
      })
    },
    rebind(clientKey: unknown, connected = true) {
      act(() => {
        renderer.update(createElement(Probe, { clientKey, connected }))
      })
    },
    async settle(index: number, repos: Repo[]) {
      await act(async () => {
        pending[index]!.resolve(repos)
        await Promise.resolve()
      })
    },
    async fail(index: number, message: string) {
      await act(async () => {
        pending[index]!.reject(new Error(message))
        await Promise.resolve()
      })
    }
  }
}

describe('useHostRepoList', () => {
  it('fetches once and then serves the cached list', async () => {
    const probe = mountResource()
    let first: Repo[] = []
    await act(async () => {
      void probe.resource.ensureLoaded().then((repos) => {
        first = repos
      })
    })
    await probe.settle(0, [{ id: 'a' }])
    expect(first).toEqual([{ id: 'a' }])
    expect(probe.resource.state.status).toBe('loaded')

    await act(async () => {
      await probe.resource.ensureLoaded()
    })
    expect(probe.callCount).toBe(1)
  })

  // Regression (#12966): a host with no repos must not be re-fetched forever.
  it('treats an empty response as a real answer', async () => {
    const probe = mountResource()
    await act(async () => {
      void probe.resource.ensureLoaded()
    })
    await probe.settle(0, [])
    await act(async () => {
      await probe.resource.ensureLoaded()
    })
    expect(probe.callCount).toBe(1)
    expect(probe.resource.state.status).toBe('loaded')
  })

  it('collapses concurrent callers into one request', async () => {
    const probe = mountResource()
    await act(async () => {
      void probe.resource.ensureLoaded()
      void probe.resource.ensureLoaded()
    })
    expect(probe.callCount).toBe(1)
  })

  it('retries after a failure instead of caching it', async () => {
    const probe = mountResource()
    await act(async () => {
      void probe.resource.ensureLoaded().catch(() => {})
    })
    await probe.fail(0, 'offline')
    expect(probe.resource.state.status).toBe('error')
    expect(probe.resource.state.error).toBe('offline')
    await act(async () => {
      void probe.resource.ensureLoaded().catch(() => {})
    })
    expect(probe.callCount).toBe(2)
  })

  // Regression: the screen is reused across hosts, so the previous host's list
  // must never answer for the new one.
  it('drops the cached list as soon as the client changes', async () => {
    const probe = mountResource()
    await act(async () => {
      void probe.resource.ensureLoaded()
    })
    await probe.settle(0, [{ id: 'from-host-a' }])
    expect(probe.resource.state.repos).toEqual([{ id: 'from-host-a' }])

    probe.rebind('client-b')
    expect(probe.resource.state.status).toBe('idle')
    expect(probe.resource.state.repos).toEqual([])

    await act(async () => {
      void probe.resource.ensureLoaded()
    })
    expect(probe.callCount).toBe(2)
  })

  // Regression: navigation keeps the old client alive, so its slow repo.list can
  // still resolve after the swap. It must not become the new host's answer.
  it('discards a response that arrives after the client changed', async () => {
    const probe = mountResource()
    await act(async () => {
      void probe.resource.ensureLoaded()
    })
    probe.rebind('client-b')
    await probe.settle(0, [{ id: 'from-host-a' }])

    expect(probe.resource.state.status).toBe('idle')
    expect(probe.resource.state.repos).toEqual([])

    await act(async () => {
      void probe.resource.ensureLoaded()
    })
    await probe.settle(1, [{ id: 'from-host-b' }])
    expect(probe.resource.state.repos).toEqual([{ id: 'from-host-b' }])
  })

  // Regression: A -> B -> A reuses the same client object, so a client-key match
  // alone let a stale request for A overwrite a newer result for A.
  it('discards a stale response after returning to the original client', async () => {
    const probe = mountResource()
    await act(async () => {
      void probe.resource.ensureLoaded()
    })
    probe.rebind('client-b')
    probe.rebind('client-a')
    await act(async () => {
      void probe.resource.ensureLoaded()
    })
    await probe.settle(1, [{ id: 'new-a' }])
    expect(probe.resource.state.repos).toEqual([{ id: 'new-a' }])

    await probe.settle(0, [{ id: 'stale-a' }])
    expect(probe.resource.state.repos).toEqual([{ id: 'new-a' }])
  })

  // Regression: a refresh calls reload() and loadTasks() in the same event, and
  // React has not rendered the `requested` dispatch yet, so ensureLoaded saw
  // `loaded` and returned the very list the reload was replacing.
  it('joins an in-flight reload instead of serving the list it will replace', async () => {
    const probe = mountResource()
    await act(async () => {
      void probe.resource.ensureLoaded()
    })
    await probe.settle(0, [{ id: 'stale' }])

    let joined: Repo[] = []
    await act(async () => {
      void probe.resource.reload()
      void probe.resource.ensureLoaded().then((repos) => {
        joined = repos
      })
    })
    expect(probe.callCount).toBe(2)
    await probe.settle(1, [{ id: 'fresh' }])
    expect(joined).toEqual([{ id: 'fresh' }])
  })

  it('stays idle with no connection instead of caching an empty answer', async () => {
    const probe = mountResource()
    probe.rebind('client-a', false)
    await act(async () => {
      expect(await probe.resource.ensureLoaded()).toEqual([])
    })
    expect(probe.callCount).toBe(0)
    expect(probe.resource.state.status).toBe('idle')
  })

  // Regression: the resource used to be a fresh object per render, so consumers
  // that held it in a dependency array re-created their callbacks every render
  // and their effects re-fired forever ("Maximum update depth exceeded").
  it('keeps a stable identity across renders that change nothing', async () => {
    const probe = mountResource()
    const first = probe.resource
    probe.rerender()
    expect(probe.resource).toBe(first)
    expect(probe.resource.ensureLoaded).toBe(first.ensureLoaded)
    expect(probe.resource.reload).toBe(first.reload)

    await act(async () => {
      void probe.resource.ensureLoaded()
    })
    await probe.settle(0, [{ id: 'a' }])
    // A load changes state, so the object may differ, but the callbacks must not.
    expect(probe.resource.ensureLoaded).toBe(first.ensureLoaded)
    expect(probe.resource.reload).toBe(first.reload)
    const loaded = probe.resource
    probe.rerender()
    expect(probe.resource).toBe(loaded)
  })

  it('re-reads the host on an explicit reload', async () => {
    const probe = mountResource()
    await act(async () => {
      void probe.resource.ensureLoaded()
    })
    await probe.settle(0, [{ id: 'a' }])
    await act(async () => {
      void probe.resource.reload()
    })
    expect(probe.callCount).toBe(2)
    // The previous list stays visible while the reload is in flight.
    expect(probe.resource.state.repos).toEqual([{ id: 'a' }])
    await probe.settle(1, [{ id: 'a' }, { id: 'b' }])
    expect(probe.resource.state.repos).toEqual([{ id: 'a' }, { id: 'b' }])
  })
})
