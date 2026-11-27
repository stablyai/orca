import { beforeEach, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import { STRUCTURED_AGENT_SESSION_SET_BADGE_METHODS } from './structured-agent-session-set-badge'

const BADGE = { label: 'Linked to Blender', icon: 'data:image/png;base64,iVBORw0KGgo=' }
const records = new Map<string, { badge?: unknown }>()
const published: string[] = []
const host = {
  deps: {
    store: {
      getRecord: (id: string) => records.get(id) ?? null,
      updateRecord: async (id: string, command: { badge: typeof BADGE | null }) => {
        const record = command.badge ? { badge: command.badge } : {}
        records.set(id, record)
        return record
      }
    }
  },
  publishConversationName: (id: string) => published.push(id)
}

vi.mock('../creation/structured-agent-session-gate', () => ({
  requireRenameStructuredHost: async () => host
}))

const [method] = STRUCTURED_AGENT_SESSION_SET_BADGE_METHODS
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate that reads ctx is replaced above.
const ctx = {} as RpcContext
const call = (sessionId: string, badge: unknown) =>
  method.handler(method.params.parse({ sessionId, badge }), ctx)

beforeEach(() => {
  records.clear()
  records.set('session-alpha-1', {})
  published.length = 0
})

it('saves the badge and tells every client, then clears it', async () => {
  expect(await call('session-alpha-1', BADGE)).toEqual({ badge: BADGE })
  expect(records.get('session-alpha-1')).toEqual({ badge: BADGE })
  expect(await call('session-alpha-1', null)).toEqual({ badge: null })
  expect(records.get('session-alpha-1')).toEqual({})
  expect(published).toEqual(['session-alpha-1', 'session-alpha-1'])
})

it('refuses a picture that is not an inline image, and an unknown chat', async () => {
  await expect(
    call('session-alpha-1', { label: 'Blender', icon: 'https://example.com/logo.png' })
  ).rejects.toThrow('agent_session_badge_invalid')
  await expect(call('session-beta-9', BADGE)).rejects.toThrow('agent_session_identity_required')
  expect(records.get('session-alpha-1')).toEqual({})
  expect(published).toEqual([])
})
