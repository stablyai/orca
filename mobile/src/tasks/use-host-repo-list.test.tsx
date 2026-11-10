import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { useHostRepoList, type HostRepoListResource } from './use-host-repo-list'

type Repo = { id: string }

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

  // The previous client can resolve after host navigation; its list must not become the new host’s answer.
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

  // A → B → A reuses client identity; an old A reply must not overwrite a newer A result.
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

  // Reload and ensureLoaded share an event before requested state commits; join the replacement request.
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

  // Keep resource/callback identities stable so consumer effects cannot form a render loop.
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
    expect(probe.resource.state.repos).toEqual([{ id: 'a' }])
    await probe.settle(1, [{ id: 'a' }, { id: 'b' }])
    expect(probe.resource.state.repos).toEqual([{ id: 'a' }, { id: 'b' }])
  })
})
