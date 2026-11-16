import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { useHostRepoList, type HostRepoListResource } from './use-host-repo-list'

type Repo = { id: string }

function mountResource() {
  const pending: { resolve: (repos: Repo[]) => void }[] = []
  let latest: HostRepoListResource<Repo> | null = null

  function Probe({ clientKey }: { clientKey: unknown }) {
    latest = useHostRepoList<Repo>(
      clientKey,
      () => new Promise<Repo[]>((resolve) => pending.push({ resolve }))
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
    rebind(clientKey: unknown) {
      act(() => {
        renderer.update(createElement(Probe, { clientKey }))
      })
    },
    async settle(index: number, repos: Repo[]) {
      await act(async () => {
        pending[index]!.resolve(repos)
        await Promise.resolve()
      })
    }
  }
}

describe('useHostRepoList', () => {
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
})
