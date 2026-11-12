import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { formatRepoList } from '../workspace-format'
import { REPO_HANDLERS } from './repo'

afterEach(() => {
  vi.restoreAllMocks()
})

function context(flags: Record<string, string>, call: ReturnType<typeof vi.fn>): HandlerContext {
  return {
    flags: new Map(Object.entries(flags)),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only call client.call.
    client: { call, isRemote: false } as unknown as RuntimeClient,
    cwd: '/',
    json: true
  }
}

describe('orca repo hide / unhide', () => {
  it('calls repo.setHidden with the selector, the flag and the --host copy', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = vi.fn(async () => ({ ok: true, result: { repo: {} } }))

    await REPO_HANDLERS['repo hide']!(context({ repo: 'name:orca', host: 'local' }, call))
    await REPO_HANDLERS['repo unhide']!(context({ repo: 'name:orca' }, call))

    expect(call.mock.calls).toEqual([
      ['repo.setHidden', { repo: 'name:orca', hidden: true, repoHostId: 'local' }],
      ['repo.setHidden', { repo: 'name:orca', hidden: false }]
    ])
  })

  it('marks hidden repos in repo list instead of leaving them out', () => {
    const base = { path: '/p', badgeColor: '', addedAt: 0 }
    const text = formatRepoList({
      repos: [
        { ...base, id: 'a', displayName: 'shown' },
        { ...base, id: 'b', displayName: 'tucked', hiddenAt: 1 }
      ]
    })
    expect(text).toBe('a  shown  /p\nb  tucked  /p  (hidden)')
  })
})
