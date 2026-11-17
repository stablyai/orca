import { describe, expect, it } from 'vitest'
import { wakeCloudWorkspace } from './cloud-control-plane-client'
import { CloudRequestError } from './cloud-control-plane-request'

const ready = { state: 'ready', endpoint: null, readyAt: 1, sandboxId: 'sbx_a' }

function plane(answers: Record<string, () => Response>) {
  const calls: string[] = []
  return {
    calls,
    plane: {
      baseUrl: 'https://cp.test',
      token: () => 'tok',
      fetch: async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname
        calls.push(path)
        const answer = answers[path]
        return answer ? answer() : Response.json({ error: 'not_found' }, { status: 404 })
      }
    }
  }
}

describe('wakeCloudWorkspace', () => {
  it('wakes through the team route, so a teammate can wake a team workspace', async () => {
    const { plane: p, calls } = plane({
      '/v1/team/workspaces/sbx_a/wake': () => Response.json(ready)
    })
    expect(await wakeCloudWorkspace(p, 'sbx_a')).toEqual({ state: 'ready', endpoint: null })
    expect(calls).toEqual(['/v1/team/workspaces/sbx_a/wake'])
  })

  it('falls back to the owner route when the team route is not found (older server, archived owner row)', async () => {
    const { plane: p, calls } = plane({
      '/v1/sandboxes/sbx_a/wake': () => Response.json({ ...ready, state: 'archived' })
    })
    expect(await wakeCloudWorkspace(p, 'sbx_a')).toEqual({ state: 'archived', endpoint: null })
    expect(calls).toEqual(['/v1/team/workspaces/sbx_a/wake', '/v1/sandboxes/sbx_a/wake'])
  })

  it('does not retry the owner route on a server error, and reports not_found when neither route knows it', async () => {
    const failing = plane({
      '/v1/team/workspaces/sbx_a/wake': () => Response.json({ error: 'internal' }, { status: 500 })
    })
    await expect(wakeCloudWorkspace(failing.plane, 'sbx_a')).rejects.toBeInstanceOf(
      CloudRequestError
    )
    expect(failing.calls).toEqual(['/v1/team/workspaces/sbx_a/wake'])
    // Refusals other than not_found never retry on the owner route.
    for (const status of [401, 403]) {
      const refused = plane({
        '/v1/team/workspaces/sbx_a/wake': () => Response.json({ error: 'forbidden' }, { status })
      })
      await expect(wakeCloudWorkspace(refused.plane, 'sbx_a')).rejects.toMatchObject({ status })
      expect(refused.calls).toEqual(['/v1/team/workspaces/sbx_a/wake'])
    }
    const stranger = plane({})
    await expect(wakeCloudWorkspace(stranger.plane, 'sbx_a')).rejects.toMatchObject({
      status: 404,
      code: 'not_found'
    })
  })
})
