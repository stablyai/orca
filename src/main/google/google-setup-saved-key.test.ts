import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoogleSetupRun } from '../../shared/google/google-setup-run'
import { recordClientDownloadCommit } from '../runtime/browser/downloads/client-download-provenance'

const mocks = vi.hoisted(() => ({
  home: '',
  run: null as GoogleSetupRun | null,
  importClient: vi.fn(async (_text: string) => {})
}))
vi.mock('../bots/bot-home', () => ({ botHomeFolder: () => mocks.home }))
vi.mock('./google-setup-runs', () => ({ googleSetupRuns: () => ({ get: () => mocks.run }) }))
vi.mock('./google-connect', () => ({
  getGoogleConnect: () => ({ importClient: mocks.importClient })
}))

import { importGoogleSetupKeySavedHere } from './google-setup-saved-key'

const BOT = { id: 'ivy', folder: 'ivy', folderWorkspaceId: 'fw-ivy' }
const key = (project: string) =>
  JSON.stringify({
    installed: {
      client_id: '1.apps.googleusercontent.com',
      client_secret: 's',
      project_id: project
    }
  })

let downloads = ''
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
    startedAt: Date.now(),
    updatedAt: Date.now(),
    revision: 1
  }
})

describe('Import file on the agent’s host', () => {
  it("imports the file this host saw the setup's page download, and only then removes it", async () => {
    writeFileSync(join(downloads, 'client_secret_old.json'), key('old'))
    writeFileSync(join(downloads, 'client_secret_new.json'), key('new'))
    recordClientDownloadCommit({
      workspaceId: 'folder:fw-ivy',
      browserPageId: 'page-2',
      workspaceRelativePath: '.orca/browser-downloads/client_secret_new.json',
      committedAt: Date.now()
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
    writeFileSync(join(downloads, 'client_secret_later.json'), key('later'))
    recordClientDownloadCommit({
      workspaceId: 'folder:fw-ivy',
      browserPageId: 'page-5',
      workspaceRelativePath: '.orca/browser-downloads/client_secret_later.json',
      // Committed well before the file now at that name was written.
      committedAt: Date.now() - 60_000
    })
    recordClientDownloadCommit({
      workspaceId: 'folder:fw-ivy',
      browserPageId: 'page-6',
      workspaceRelativePath: '.orca/browser-downloads/client_secret_gone.json',
      committedAt: Date.now()
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
    const [picked] = (listed as { candidates: { name: string; id: string }[] }).candidates

    // Replaced since it was listed: not the file the owner picked.
    writeFileSync(join(downloads, 'client_secret_a.json'), key('a-replaced'))
    await expect(
      importGoogleSetupKeySavedHere(BOT, async () => {}, { ...picked, id: `${picked.id}-stale` })
    ).rejects.toThrow('changed or is gone')
    expect(existsSync(join(downloads, 'client_secret_a.json'))).toBe(true)
  })

  it('brings back a key an interrupted import left hidden, so the owner can pick it', async () => {
    mocks.run = { ...mocks.run!, browserPageId: 'page-7' }
    const crashedAt = Date.now() - 5 * 60_000
    writeFileSync(join(downloads, `.importing-${crashedAt}-dead`), key('stranded'))
    expect(await importGoogleSetupKeySavedHere(BOT, async () => {})).toMatchObject({
      found: false,
      candidates: [{ name: `client_secret_recovered-${crashedAt}.json` }]
    })
  })

  it('still finishes the step when the imported key file can’t be deleted', async () => {
    mocks.run = { ...mocks.run!, browserPageId: 'page-8' }
    writeFileSync(join(downloads, 'client_secret_c.json'), key('c'))
    const [picked] = (
      (await importGoogleSetupKeySavedHere(BOT, async () => {})) as {
        candidates: { name: string; id: string }[]
      }
    ).candidates
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
    const [picked] = (
      (await importGoogleSetupKeySavedHere(BOT, async () => {})) as {
        candidates: { name: string; id: string }[]
      }
    ).candidates
    mocks.importClient.mockRejectedValueOnce(new Error('not a desktop client'))
    await expect(importGoogleSetupKeySavedHere(BOT, async () => {}, picked)).rejects.toThrow(
      'not a desktop client'
    )
    expect(existsSync(join(downloads, 'client_secret_b.json'))).toBe(true)
  })
})
