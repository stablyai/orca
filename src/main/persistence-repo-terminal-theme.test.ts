import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  makeRepo
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../shared/constants'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => false
  }
}))

vi.mock('./telemetry/client', () => ({
  track: vi.fn()
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

describe('Store repo terminal theme overrides', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('stores a terminal theme override and keeps it across reloads', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', { terminalTheme: { dark: ' Dracula ' } })

    expect(updated?.terminalTheme).toEqual({ dark: 'Dracula' })
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')?.terminalTheme).toEqual({ dark: 'Dracula' })
  })

  it('replaces the whole override object instead of merging variants', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ terminalTheme: { dark: 'Dracula' } }))

    store.updateRepo('r1', { terminalTheme: { light: 'X' } })

    expect(store.getRepo('r1')?.terminalTheme).toEqual({ light: 'X' })
  })

  it('treats null as the clear sentinel', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ terminalTheme: { dark: 'Dracula' } }))

    store.updateRepo('r1', { terminalTheme: null })

    expect(store.getRepo('r1')).not.toHaveProperty('terminalTheme')
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')?.terminalTheme).toBeUndefined()
  })

  it('ignores a malformed override and keeps the stored value', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ terminalTheme: { dark: 'Dracula' } }))
    const garbage = JSON.parse('{"dark":5}')

    store.updateRepo('r1', { displayName: 'renamed', terminalTheme: garbage })

    expect(store.getRepo('r1')).toMatchObject({
      displayName: 'renamed',
      terminalTheme: { dark: 'Dracula' }
    })
  })

  it('drops a malformed persisted override on load', async () => {
    const persisted = getDefaultPersistedState(testState.dir)
    writeDataFile({
      ...persisted,
      repos: [
        { ...makeRepo({ id: 'bad' }), terminalTheme: 'bad' },
        { ...makeRepo({ id: 'partial', path: '/other' }), terminalTheme: { dark: 5, light: 'X' } }
      ]
    })

    const store = await createStore()

    expect(store.getRepo('bad')).not.toHaveProperty('terminalTheme')
    expect(store.getRepo('partial')?.terminalTheme).toEqual({ light: 'X' })
  })

  it('host-scoped updates write only the addressed row', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'shared', path: '/local/repo' }))
    store.addRepo(
      makeRepo({
        id: 'shared',
        path: '/remote/repo',
        connectionId: 'x',
        executionHostId: 'ssh:x'
      })
    )

    store.updateRepo('shared', { terminalTheme: { dark: 'Dracula' } }, 'ssh:x')

    const rows = store.getRepos().filter((repo) => repo.id === 'shared')
    expect(rows.find((repo) => repo.path === '/local/repo')).not.toHaveProperty('terminalTheme')
    expect(rows.find((repo) => repo.path === '/remote/repo')?.terminalTheme).toEqual({
      dark: 'Dracula'
    })
  })
})
