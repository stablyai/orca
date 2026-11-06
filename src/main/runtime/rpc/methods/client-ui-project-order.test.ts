import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

function host(initial: PersistedUIState = getDefaultUIState()) {
  let ui = initial
  const implementation = {
    getRuntimeId: () => 'project-order-test',
    getUIState: () => ui,
    updateUIState: (updates: Partial<PersistedUIState>) => (ui = { ...ui, ...updates })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these UI methods use only the store boundary above.
  const runtime = implementation as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
  let id = 0
  const call = (method: string, params: unknown) =>
    dispatcher.dispatch({ id: String(++id), authToken: 'tok', method, params })
  const open = (
    writer: string,
    seq: number,
    projectKey = 'github:alpha',
    previousProjectKey: string | null = 'github:beta'
  ) => call('ui.recordProjectOpen', { projectKey, previousProjectKey, opId: { writer, seq } })
  return { call, open, read: () => ui }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('personal project order UI mutations', () => {
  it('acknowledges concurrent distinct opens and replays safely after restart', async () => {
    const first = host()
    const replies = await Promise.all([first.open('desktop', 1), first.open('phone', 1)])
    expect(replies.every((reply) => reply.ok)).toBe(true)
    expect(first.read()).toMatchObject({
      personalProjectOrder: { projects: { 'github:alpha': { openCount: 2 } } }
    })
    const restarted = host(JSON.parse(JSON.stringify(first.read())))
    expect(await restarted.open('desktop', 1)).toMatchObject({
      ok: true,
      result: { applied: false }
    })
    await restarted.open('desktop', 2, 'github:beta', 'github:alpha')
    await restarted.open('desktop', 3)
    expect(restarted.read()).toMatchObject({
      personalProjectOrder: {
        projects: { 'github:alpha': { openCount: 3 }, 'github:beta': { openCount: 1 } }
      }
    })
  })

  it('settles no-op transitions and preserves usage/pins through unrelated old-client patches', async () => {
    const current = host()
    expect(await current.open('desktop', 1, 'github:alpha', 'github:alpha')).toMatchObject({
      ok: true,
      result: { applied: false }
    })
    await current.open('desktop', 2)
    expect(
      await current.call('ui.setProjectPinned', {
        projectKey: 'github:alpha',
        pinned: true,
        opId: { writer: 'desktop', seq: 3 }
      })
    ).toMatchObject({ ok: true })
    await current.call('ui.set', { sidebarWidth: 240, projectOrderBy: 'name' })
    expect(current.read()).toMatchObject({
      projectOrderBy: 'name',
      personalProjectOrder: { projects: { 'github:alpha': { openCount: 1, pinned: true } } }
    })
    await current.open('desktop', 1)
    expect(current.read()).toMatchObject({
      personalProjectOrder: { projects: { 'github:alpha': { openCount: 1 } } }
    })
  })

  it.each([Number.NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid sequence %s without recording',
    async (seq) => {
      const current = host()
      expect(await current.open('writer', seq)).toMatchObject({ ok: false })
      expect(current.read()).not.toHaveProperty('personalProjectOrder')
    }
  )

  it('keeps distinct reordered operations, saturates counts and stamps with the monotonic owner clock', async () => {
    const current = host({
      ...getDefaultUIState(),
      personalProjectOrder: {
        projects: {
          'github:alpha': { openCount: Number.MAX_SAFE_INTEGER, lastOpenedAt: 500, pinned: true }
        },
        settledOperations: []
      }
    })
    vi.spyOn(Date, 'now').mockReturnValue(Number.NaN)
    await current.open('reordered', 2)
    await current.open('reordered', 1)
    const preference = current.read().personalProjectOrder?.projects['github:alpha']
    expect(preference).toMatchObject({
      openCount: Number.MAX_SAFE_INTEGER,
      lastOpenedAt: 502,
      pinned: true
    })
    expect(Number.isSafeInteger(preference?.lastOpenedAt)).toBe(true)
  })
})
