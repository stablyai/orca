import { afterEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { requestConnector } from '../../../connector-cloud/connector-cloud-request'
const logins = vi.hoisted(() => ({ clear: vi.fn() }))
vi.mock('../../../linear/accounts/linear-login-store', () => ({
  clearWorkspaceLogin: logins.clear
}))

import { BOT_LINKS_LIST as list, BOT_LINKS_UNLINK as unlink } from './bots-links'

type Context = Parameters<typeof list.handler>[1]

/** The host's connector cloud over a fake Orca Cloud, through the real request and schema parsing. */
function host(answer: (method: string, path: string) => Response) {
  const calls: { method: string; path: string }[] = []
  const cloud = {
    call: (
      path: string,
      body: unknown,
      schema: z.ZodType,
      options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE' } = {}
    ) =>
      requestConnector(
        {
          url: `https://cloud.test${path}`,
          method: options.method,
          body,
          fetchImpl: async (url, init) => {
            const call = { method: init?.method ?? 'POST', path: new URL(String(url)).pathname }
            calls.push(call)
            return answer(call.method, call.path)
          }
        },
        schema
      )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only getConnectorCloud.
  const context = { runtime: { getConnectorCloud: () => cloud } } as unknown as Context
  return { calls, context }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const linearLink = (workspaceId: string, userId: string) => ({
  source: 'linear',
  workspaceId,
  workspaceName: 'Acme Linear',
  userId,
  name: userId,
  linkedAt: 1
})

afterEach(() => logins.clear.mockReset())

describe('bots.links.*', () => {
  it('lists several links per source and skips a source this build does not know', async () => {
    const { context } = host(() =>
      json({
        links: [
          {
            source: 'github',
            workspaceId: 'github.com',
            workspaceName: '',
            userId: '1',
            name: 'a',
            linkedAt: 1
          },
          {
            source: 'github',
            workspaceId: 'github.com',
            workspaceName: '',
            userId: '2',
            name: 'b',
            linkedAt: 2
          },
          {
            source: 'slack',
            workspaceId: 'T1',
            workspaceName: 'Acme',
            userId: 'U1',
            name: 'Dana',
            linkedAt: 3
          },
          {
            source: 'jira',
            workspaceId: 'J',
            workspaceName: 'J',
            userId: 'x',
            name: 'x',
            linkedAt: 4
          }
        ]
      })
    )
    const result = await list.handler(undefined, context)
    expect(result).toEqual({
      ok: true,
      value: {
        links: [
          {
            source: 'github',
            workspaceId: 'github.com',
            workspaceName: '',
            userId: '1',
            name: 'a',
            linkedAt: 1
          },
          {
            source: 'github',
            workspaceId: 'github.com',
            workspaceName: '',
            userId: '2',
            name: 'b',
            linkedAt: 2
          },
          {
            source: 'slack',
            workspaceId: 'T1',
            workspaceName: 'Acme',
            userId: 'U1',
            name: 'Dana',
            linkedAt: 3
          }
        ]
      }
    })
  })

  it('unlinks exactly the named link, with each segment encoded', async () => {
    const { calls, context } = host(() => new Response(null, { status: 204 }))
    const result = await unlink.handler(
      { source: 'slack', workspaceId: 'T/1', userId: 'user 2' },
      context
    )
    expect(result).toEqual({ ok: true, value: undefined })
    expect(calls).toEqual([{ method: 'DELETE', path: '/v1/connector/links/slack/T%2F1/user%202' }])
    expect(logins.clear).not.toHaveBeenCalled()
  })

  it("forgets a Linear workspace's login with its last link there, not before", async () => {
    const left: unknown[] = [linearLink('org-1', 'dana')]
    const { context } = host((method) =>
      method === 'DELETE' ? new Response(null, { status: 204 }) : json({ links: left })
    )
    await unlink.handler({ source: 'linear', workspaceId: 'org-1', userId: 'mara' }, context)
    expect(logins.clear).not.toHaveBeenCalled()

    left.length = 0
    await unlink.handler({ source: 'linear', workspaceId: 'org-1', userId: 'dana' }, context)
    expect(logins.clear).toHaveBeenCalledExactlyOnceWith('org-1')
  })

  it('keeps the Linear login when the unlink fails', async () => {
    const { context } = host((method) =>
      method === 'DELETE' ? json({ error: 'not_linked' }, 404) : json({ links: [] })
    )
    await unlink.handler({ source: 'linear', workspaceId: 'org-1', userId: 'x' }, context)
    expect(logins.clear).not.toHaveBeenCalled()
  })

  it("answers not_linked for a link that isn't the caller's", async () => {
    const { context } = host(() => json({ error: 'not_linked' }, 404))
    const result = await unlink.handler(
      { source: 'github', workspaceId: 'github.com', userId: '9' },
      context
    )
    expect(result).toEqual({ ok: false, error: 'not_linked' })
  })

  it('reads a bare 404 as a cloud from before linked accounts', async () => {
    const { context } = host(() => new Response('', { status: 404 }))
    expect(await list.handler(undefined, context)).toEqual({ ok: false, error: 'links_off' })
  })
})
