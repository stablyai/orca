import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoogleSetupRun } from '../../shared/google/google-setup-run'
import { recordClientDownloadCommit } from '../runtime/browser/downloads/client-download-provenance'

const mocks = vi.hoisted(() => {
  const state: { home: string; run: GoogleSetupRun | null } = { home: '', run: null }
  return Object.assign(state, { importClient: vi.fn(async (_text: string) => {}) })
})
vi.mock('../bots/bot-home', () => ({ botHomeFolder: () => mocks.home }))
vi.mock('./google-setup-runs', () => ({ googleSetupRuns: () => ({ get: () => mocks.run }) }))
vi.mock('./google-connect', () => ({
  getGoogleConnect: () => ({ importClient: mocks.importClient })
}))

import { importGoogleSetupKeySavedHere, type SavedKeyImport } from './google-setup-saved-key'

function candidatesOf(result: SavedKeyImport) {
  if (result.found) {
    throw new Error('expected a list to pick from')
  }
  return result.candidates
}

const BOT = { id: 'ivy', folder: 'ivy', folderWorkspaceId: 'fw-ivy' }
const key = (project: string) =>
  JSON.stringify({
    installed: {
      client_id: '1.apps.googleusercontent.com',
      client_secret: 's',
      project_id: project
    }
  })

// A fixed clock for file times and commits, so nothing here depends on when it runs.
const T = 1_700_000_000_000

let downloads = ''
function writeKeyAt(name: string, project: string, mtimeMs: number): void {
  const file = join(downloads, name)
  writeFileSync(file, key(project))
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
}
beforeEach(() => {
  mocks.home = mkdtempSync(join(tmpdir(), 'orca-saved-key-'))
  downloads = join(mocks.home, '.orca', 'browser-downloads')
  mkdirSync(downloads, { recursive: true })
  mocks.importClient.mockClear()
  mocks.run = {
    id: 'run-2',
    botId: 'ivy',
    state: 'running',
    mode: 'do-it-for-me',
    steps: {},
    answers: {},
    browserPageId: 'page-2',
    startedAt: T - 3_600_000,
    updatedAt: T - 3_600_000,
    revision: 1
  }
})

describe('Import file on the agent’s host', () => {
  it("imports the file this host saw the setup's page download, and only then removes it", async () => {
    writeFileSync(join(downloads, 'client_secret_old.json'), key('old'))
    writeKeyAt('client_secret_new.json', 'new', T)
    recordClientDownloadCommit({
      workspaceId: 'folder:fw-ivy',
      browserPageId: 'page-2',
      workspaceRelativePath: '.orca/browser-downloads/client_secret_new.json',
      committedAt: T
    })
    const arrived = vi.fn(async () => {})
    expect(await importGoogleSetupKeySavedHere(BOT, arrived)).toEqual({ found: true })
    expect(mocks.importClient).toHaveBeenCalledExactlyOnceWith(key('new'))
    expect(arrived).toHaveBeenCalledOnce()
    expect(existsSync(join(downloads, 'client_secret_new.json'))).toBe(false)
    expect(existsSync(join(downloads, 'client_secret_old.json'))).toBe(true)
  })

  it('asks the owner to pick when the recorded file is gone or was replaced since', async () => {
    mocks.run = { ...mocks.run!, browserPageId: 'page-5' }
    writeKeyAt('client_secret_later.json', 'later', T)
    recordClientDownloadCommit({
      workspaceId: 'folder:fw-ivy',
      browserPageId: 'page-5',
      workspaceRelativePath: '.orca/browser-downloads/client_secret_later.json',
      // Committed well before the file now at that name was written.
      committedAt: T - 60_000
    })
    recordClientDownloadCommit({
      workspaceId: 'folder:fw-ivy',
      browserPageId: 'page-6',
      workspaceRelativePath: '.orca/browser-downloads/client_secret_gone.json',
      committedAt: T
    })
    expect(await importGoogleSetupKeySavedHere(BOT, async () => {})).toMatchObject({
      found: false,
      candidates: [{ name: 'client_secret_later.json' }]
    })
    mocks.run = { ...mocks.run!, browserPageId: 'page-6' }
    expect(await importGoogleSetupKeySavedHere(BOT, async () => {})).toMatchObject({
      found: false,
      candidates: [{ name: 'client_secret_later.json' }]
    })
    expect(mocks.importClient).not.toHaveBeenCalled()
  })

  it('lists the files for the owner to pick when it saw none, and takes only the exact pick', async () => {
    mocks.run = { ...mocks.run!, browserPageId: 'page-3' }
    writeFileSync(join(downloads, 'client_secret_a.json'), key('a'))
    const listed = await importGoogleSetupKeySavedHere(BOT, async () => {})
    expect(listed).toMatchObject({ found: false, candidates: [{ name: 'client_secret_a.json' }] })
    expect(mocks.importClient).not.toHaveBeenCalled()
    const [picked] = candidatesOf(listed)

    // Replaced since it was listed: not the file the owner picked.
    writeFileSync(join(downloads, 'client_secret_a.json'), key('a-replaced'))
    await expect(
      importGoogleSetupKeySavedHere(BOT, async () => {}, { ...picked, id: `${picked.id}-stale` })
    ).rejects.toThrow('changed or is gone')
    expect(existsSync(join(downloads, 'client_secret_a.json'))).toBe(true)
  })

  it('brings back a key an interrupted import left hidden, so the owner can pick it', async () => {
    mocks.run = { ...mocks.run!, browserPageId: 'page-7' }
    // Named for when its import began, long ago.
    const crashedAt = 1_000
    writeFileSync(join(downloads, `.importing-${crashedAt}-dead`), key('stranded'))
    expect(await importGoogleSetupKeySavedHere(BOT, async () => {})).toMatchObject({
      found: false,
      candidates: [{ name: `client_secret_recovered-${crashedAt}.json` }]
    })
  })

  it('still finishes the step when the imported key file can’t be deleted', async () => {
    mocks.run = { ...mocks.run!, browserPageId: 'page-8' }
    writeFileSync(join(downloads, 'client_secret_c.json'), key('c'))
    const [picked] = candidatesOf(await importGoogleSetupKeySavedHere(BOT, async () => {}))
    // The folder turns read-only during the import, so the cleanup that follows fails.
    mocks.importClient.mockImplementationOnce(async () => chmodSync(downloads, 0o555))
    const arrived = vi.fn(async () => {})
    try {
      expect(await importGoogleSetupKeySavedHere(BOT, arrived, picked)).toEqual({ found: true })
      expect(arrived).toHaveBeenCalledOnce()
      // The cleanup really failed: the claimed copy is still there.
      expect(readdirSync(downloads).some((name) => name.startsWith('.importing-'))).toBe(true)
    } finally {
      chmodSync(downloads, 0o755)
    }
  })

  it('keeps the file when the import fails', async () => {
    mocks.run = { ...mocks.run!, browserPageId: 'page-4' }
    writeFileSync(join(downloads, 'client_secret_b.json'), key('b'))
    const [picked] = candidatesOf(await importGoogleSetupKeySavedHere(BOT, async () => {}))
    mocks.importClient.mockRejectedValueOnce(new Error('not a desktop client'))
    await expect(importGoogleSetupKeySavedHere(BOT, async () => {}, picked)).rejects.toThrow(
      'not a desktop client'
    )
    expect(existsSync(join(downloads, 'client_secret_b.json'))).toBe(true)
  })
})
