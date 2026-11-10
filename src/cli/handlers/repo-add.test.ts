import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { REPO_HANDLERS } from './repo'

function context(flags: Record<string, string | boolean>) {
  const call = vi.fn(async () => ({
    repo: { id: 'r1', path: '/vercel/sandbox/project', displayName: 'Hello-World' }
  }))
  const ctx: HandlerContext = {
    flags: new Map(Object.entries(flags)),
    cwd: '/tmp',
    json: true,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: repo add only uses client.call and client.isRemote
    client: { call, isRemote: false } as unknown as HandlerContext['client']
  }
  return { ctx, call }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('orca repo add --display-name', () => {
  it('passes the display name to repo.add (cloud sandboxes name the project checkout after its repo)', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { ctx, call } = context({
      path: '/vercel/sandbox/project',
      'display-name': 'Hello-World',
      json: true
    })
    await REPO_HANDLERS['repo add']!(ctx)
    expect(call).toHaveBeenCalledWith('repo.add', {
      path: '/vercel/sandbox/project',
      displayName: 'Hello-World'
    })
  })

  it('omits displayName when the flag is absent', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { ctx, call } = context({ path: '/vercel/sandbox/project', json: true })
    await REPO_HANDLERS['repo add']!(ctx)
    expect(call).toHaveBeenCalledWith('repo.add', { path: '/vercel/sandbox/project' })
  })
})
