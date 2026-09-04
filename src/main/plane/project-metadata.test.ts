import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaneState, PlaneWorkspace } from '../../shared/plane-types'
import { pickStateForGroup } from './project-metadata'

const OLD_FETCH = globalThis.fetch
const { netFetchMock, resolveProxyMock, setProxyMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  resolveProxyMock: vi.fn(),
  setProxyMock: vi.fn()
}))

let tempHome = ''

const workspace: PlaneWorkspace = {
  id: 'ws-1',
  slug: 'acme',
  name: 'acme',
  baseUrl: 'https://api.plane.so',
  appUrl: 'https://app.plane.so',
  deployment: 'cloud'
}
const client = { workspace, apiToken: 'plane_api_secret' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

async function loadMetadata() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    net: { fetch: netFetchMock },
    safeStorage: { isEncryptionAvailable: () => false },
    session: { defaultSession: { resolveProxy: resolveProxyMock, setProxy: setProxyMock } }
  }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./project-metadata')
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-plane-meta-'))
  globalThis.fetch = vi.fn(async () => {
    throw new Error('global fetch must not be used; Plane goes through net.fetch')
  }) as unknown as typeof fetch
  netFetchMock.mockReset()
  resolveProxyMock.mockReset()
  setProxyMock.mockReset()
  resolveProxyMock.mockResolvedValue('DIRECT')
})

afterEach(() => {
  globalThis.fetch = OLD_FETCH
})

describe('pickStateForGroup', () => {
  const states: PlaneState[] = [
    { id: 's-todo', name: 'Todo', group: 'unstarted' },
    { id: 's-doing', name: 'In Progress', group: 'started', default: true },
    { id: 's-review', name: 'In Review', group: 'started' },
    { id: 's-done', name: 'Done', group: 'completed' }
  ]

  it('prefers the project default within the group', () => {
    expect(pickStateForGroup(states, 'started')?.id).toBe('s-doing')
  })

  it('falls back to the first state in the group when none is default', () => {
    expect(pickStateForGroup(states, 'completed')?.id).toBe('s-done')
  })

  it('honours an explicit name over the group default, case-insensitively', () => {
    expect(pickStateForGroup(states, 'started', 'in review')?.id).toBe('s-review')
  })

  it('returns null for a named state the project does not have', () => {
    expect(pickStateForGroup(states, 'started', 'Shipped')).toBeNull()
  })

  it('returns null when the group is empty rather than guessing another group', () => {
    expect(pickStateForGroup(states, 'cancelled')).toBeNull()
  })
})

describe('listStates', () => {
  it('orders states by their configured sequence', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          { id: 's-done', name: 'Done', group: 'completed', sequence: 3 },
          { id: 's-todo', name: 'Todo', group: 'unstarted', sequence: 1 },
          { id: 's-doing', name: 'Doing', group: 'started', sequence: 2 }
        ],
        next_page_results: false
      })
    )
    const { listStates } = await loadMetadata()
    const states = await listStates(client, 'p-1')
    expect(states.map((state) => state.id)).toEqual(['s-todo', 's-doing', 's-done'])
  })
})

describe('findProjectByIdentifier', () => {
  it('matches an identifier regardless of casing', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          { id: 'p-1', identifier: 'PROJ', name: 'Platform' },
          { id: 'p-2', identifier: 'ENG', name: 'Engineering' }
        ],
        next_page_results: false
      })
    )
    const { findProjectByIdentifier } = await loadMetadata()
    await expect(findProjectByIdentifier(client, ' proj ')).resolves.toMatchObject({ id: 'p-1' })
  })

  it('returns null when no project claims the identifier', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ results: [], next_page_results: false }))
    const { findProjectByIdentifier } = await loadMetadata()
    await expect(findProjectByIdentifier(client, 'NOPE')).resolves.toBeNull()
  })
})
