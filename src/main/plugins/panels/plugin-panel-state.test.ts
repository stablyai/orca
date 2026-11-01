import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handlePluginPanelStateRequest } from './plugin-panel-state'

const PLUGIN = 'samples.todo'
let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'orca-panel-state-'))
})
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

function handle(request: unknown, plugin: string | null = PLUGIN) {
  return handlePluginPanelStateRequest(
    {
      pluginsDataDir: dataDir,
      resolveComponentsPanel: (token) => (token === 'live' ? plugin : null)
    },
    request
  )
}

describe('components panel persisted state', () => {
  it('writes plugin and per-workspace values and reads them back by scope', () => {
    expect(
      handle({
        op: 'write',
        sessionToken: 'live',
        workspace: '/repo/a',
        entries: [
          { scope: 'plugin', key: 'todos', version: 1, value: ['x'] },
          { scope: 'workspace', key: 'filter', version: 2, value: 'open' }
        ]
      })
    ).toEqual({ ok: true })
    expect(handle({ op: 'read', sessionToken: 'live', workspace: '/repo/a' })).toEqual({
      ok: true,
      state: {
        plugin: { todos: { version: 1, value: ['x'] } },
        workspace: { filter: { version: 2, value: 'open' } }
      }
    })
    expect(handle({ op: 'read', sessionToken: 'live', workspace: '/repo/b' })).toEqual({
      ok: true,
      state: { plugin: { todos: { version: 1, value: ['x'] } }, workspace: {} }
    })
  })

  it('refuses sessions that are not a live components panel, and malformed requests', () => {
    expect(handle({ op: 'read', sessionToken: 'stale', workspace: null })).toEqual({
      ok: false,
      error: 'invalid panel session'
    })
    expect(handle({ op: 'read', sessionToken: 'live', workspace: null }, null)).toMatchObject({
      ok: false
    })
    expect(
      handle({
        op: 'write',
        sessionToken: 'live',
        workspace: null,
        entries: [{ scope: 'plugin', key: '../escape', version: 1, value: 1 }]
      })
    ).toEqual({ ok: false, error: 'malformed panel state request' })
  })

  it('skips workspace values when no workspace is active', () => {
    handle({
      op: 'write',
      sessionToken: 'live',
      workspace: null,
      entries: [{ scope: 'workspace', key: 'filter', version: 1, value: 'open' }]
    })
    expect(handle({ op: 'read', sessionToken: 'live', workspace: '/repo/a' })).toMatchObject({
      state: { workspace: {} }
    })
  })
})
