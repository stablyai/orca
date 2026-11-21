import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { StandingDownloadClaim } from '../browser/guest-lifecycle/manager/downloads/browser-manager-download-creation'
import type { GoogleSetupRun } from '../../shared/google/google-setup-run'
import {
  abortClaimedClientDownload,
  beginClientDownload,
  setClientDownloadClaimant,
  writeClaimedClientDownload
} from '../runtime/browser/downloads/client-download-claims'
import {
  googleSetupClientDownloadClaimant,
  googleSetupKeyDownloadClaim,
  googleSetupWithholdsPageText
} from './google-setup-key-download'

const run = (overrides: Partial<GoogleSetupRun> = {}): GoogleSetupRun => ({
  id: 'run-1',
  botId: 'ivy',
  state: 'running',
  mode: 'do-it-for-me',
  steps: {},
  answers: {},
  browserPageId: 'setup-page',
  projectId: 'example-project-123',
  startedAt: 1,
  updatedAt: 1,
  revision: 1,
  ...overrides
})

const desktopKey = (projectId = 'example-project-123') =>
  JSON.stringify({
    installed: {
      client_id: '1.apps.googleusercontent.com',
      client_secret: 'GOCSPX-fake',
      project_id: projectId
    }
  })

const IVY_HOME = 'folder:ivy-home'

function setup(runs: GoogleSetupRun[]) {
  const deps = {
    runs: vi.fn(() => runs),
    botWorkspace: (botId: string) => (botId === 'ivy' ? IVY_HOME : 'folder:other-home'),
    importKey: vi.fn(),
    keyArrived: vi.fn(async () => {}),
    keyRefused: vi.fn(async () => {})
  }
  const claim = googleSetupKeyDownloadClaim(deps, {
    stagingDir: join(mkdtempSync(join(tmpdir(), 'orca-key-test-')), 'staging'),
    workspaceOfPage: (id) => (id === 'setup-page' ? IVY_HOME : 'folder:other-home')
  })
  return { claim, deps }
}

const KEY = {
  browserTabId: 'setup-page',
  filename: 'client_secret_123.json',
  documentUrl: 'https://console.cloud.google.com/auth/clients?project=example-project-123'
}

async function download(taken: StandingDownloadClaim, text: string): Promise<void> {
  // Chromium creates the staging folder as it saves.
  await mkdir(dirname(taken.savePath), { recursive: true })
  await writeFile(taken.savePath, text)
  taken.finish({ downloadId: 'd', status: 'completed', savePath: taken.savePath, error: null })
}

describe("a click's effects on a setup page", () => {
  it("leave out page text on the client page in a setup's tab, before and after the key arrives", () => {
    const clients = 'https://console.cloud.google.com/auth/clients/create?project=p'
    const waiting = [run({ steps: { client: { status: 'active', at: 2 } } })]
    const page = { browserPageId: 'setup-page', url: clients }
    expect(googleSetupWithholdsPageText(waiting, page)).toBe(true)
    expect(
      googleSetupWithholdsPageText(waiting, {
        ...page,
        url: 'https://console.cloud.google.com/auth/branding'
      })
    ).toBe(false)
    expect(googleSetupWithholdsPageText(waiting, { ...page, browserPageId: 'other' })).toBe(false)
    // Saving the key doesn't close the Create dialog, which still shows the secret.
    const keyIn = run({ steps: { client: { status: 'done', at: 3 } } })
    expect(googleSetupWithholdsPageText([keyIn], page)).toBe(true)
    expect(googleSetupWithholdsPageText([{ ...keyIn, state: 'done' }], page)).toBe(true)
  })
})

describe('the Google key downloaded on a setup page', () => {
  it("claims only Google Cloud's client page, in the setup's tab, while it waits for its key", () => {
    const { claim } = setup([run({ steps: { client: { status: 'active', at: 2 } } })])
    expect(claim(KEY)).not.toBeNull()
    expect(claim({ ...KEY, filename: 'report.csv' })).toBeNull()
    expect(claim({ ...KEY, browserTabId: 'other-page' })).toBeNull()
    expect(claim({ ...KEY, documentUrl: 'https://example.com/unrelated' })).toBeNull()
    expect(
      claim({ ...KEY, documentUrl: 'https://console.cloud.google.com/home/dashboard' })
    ).toBeNull()
    expect(setup([run({ steps: { client: { status: 'done', at: 2 } } })]).claim(KEY)).toBeNull()
    // The page is another agent's tab, or two runs name it: nobody's claim.
    expect(setup([run({ botId: 'rex' })]).claim(KEY)).toBeNull()
    expect(setup([run(), run({ id: 'run-2', botId: 'rex' })]).claim(KEY)).toBeNull()
  })

  it('cleans up refused downloads before reporting them and accepts a matching key on retry', async () => {
    const { claim, deps } = setup([run()])
    const wrongProject = claim(KEY)!
    await download(wrongProject, desktopKey('someone-else'))
    await vi.waitFor(() =>
      expect(deps.keyRefused).toHaveBeenCalledExactlyOnceWith(
        'ivy',
        'the key is for project someone-else, not example-project-123.'
      )
    )
    expect(existsSync(wrongProject.savePath)).toBe(false)
    expect(deps.importKey).not.toHaveBeenCalled()

    const held = Promise.withResolvers<void>()
    deps.keyRefused.mockImplementationOnce(() => held.promise)
    try {
      const wrongKind = claim(KEY)!
      await download(wrongKind, '{"web":{}}')
      await vi.waitFor(() =>
        expect(deps.keyRefused).toHaveBeenLastCalledWith(
          'ivy',
          expect.stringContaining('This is a Web app client.')
        )
      )
      expect(existsSync(wrongKind.savePath)).toBe(false)
      expect(deps.importKey).not.toHaveBeenCalled()
    } finally {
      held.resolve()
    }

    const matching = claim(KEY)!
    await download(matching, desktopKey())
    await vi.waitFor(() => expect(deps.keyArrived).toHaveBeenCalledWith('ivy'))
    expect(deps.importKey).toHaveBeenCalledExactlyOnceWith(desktopKey())
    expect(existsSync(matching.savePath)).toBe(false)
  })

  it('only deletes the file when the run that armed it was cancelled or started over', async () => {
    const runs = [run()]
    const { claim, deps } = setup(runs)
    const cancelled = claim(KEY)!
    runs[0] = run({ state: 'cancelled' })
    await download(cancelled, desktopKey())
    await vi.waitFor(() => expect(existsSync(cancelled.savePath)).toBe(false))

    runs[0] = run()
    const replaced = claim(KEY)!
    runs[0] = run({ id: 'run-2' })
    await download(replaced, desktopKey())
    await vi.waitFor(() => expect(existsSync(replaced.savePath)).toBe(false))
    expect(deps.importKey).not.toHaveBeenCalled()
    expect(deps.keyArrived).not.toHaveBeenCalled()
    expect(deps.keyRefused).not.toHaveBeenCalled()
  })
})

describe("a paired desktop's key download, claimed as it begins", () => {
  const start = {
    browserPageId: 'setup-page',
    workspaceId: IVY_HOME,
    pageHostGeneration: 4,
    filename: 'client_secret_123.json',
    documentUrl: KEY.documentUrl
  }
  const send = (transferId: string, text: string) => {
    const chunk = { browserPageId: 'setup-page', transferId, pageHostGeneration: 4 }
    expect(
      writeClaimedClientDownload({
        ...chunk,
        contentBase64: Buffer.from(text).toString('base64'),
        offset: 0,
        final: false
      })
    ).toEqual({})
    return writeClaimedClientDownload({
      ...chunk,
      contentBase64: '',
      offset: Buffer.byteLength(text),
      final: true
    })
  }

  it('imports it for the run waiting when it began, and only for that run', async () => {
    const runs = [run()]
    const { deps } = setup(runs)
    setClientDownloadClaimant(googleSetupClientDownloadClaimant(deps))
    try {
      expect(beginClientDownload('t1', { ...start, workspaceId: 'folder:other-home' })).toBe(false)
      expect(beginClientDownload('t1', { ...start, filename: 'report.csv' })).toBe(false)

      expect(beginClientDownload('t1', start)).toBe(true)
      expect(send('t1', desktopKey())).toEqual({ workspaceRelativePath: 'Google setup in Orca' })
      await vi.waitFor(() => expect(deps.keyArrived).toHaveBeenCalledWith('ivy'))
      expect(deps.importKey).toHaveBeenCalledExactlyOnceWith(desktopKey())
      // A late chunk of a handed-over claim never reaches the workspace path.
      expect(() =>
        writeClaimedClientDownload({
          browserPageId: 'setup-page',
          transferId: 't1',
          pageHostGeneration: 4,
          contentBase64: '',
          offset: 0,
          final: true
        })
      ).toThrow('browser_client_download_transfer_settled')

      // Started over while the desktop was still downloading: the new run never gets this key.
      expect(beginClientDownload('t2', start)).toBe(true)
      runs[0] = run({ id: 'run-2', projectId: undefined })
      const checks = deps.runs.mock.calls.length
      send('t2', desktopKey())
      // Its import checks the run once the bytes are in; nothing follows for a replaced run.
      await vi.waitFor(() => expect(deps.runs.mock.calls.length).toBeGreaterThan(checks))
      expect(deps.importKey).toHaveBeenCalledOnce()
      expect(deps.keyArrived).toHaveBeenCalledOnce()
    } finally {
      setClientDownloadClaimant(null)
    }
  })

  it('fails a claimed download when its desktop disconnects, so the agent hears it never arrived', async () => {
    const { deps } = setup([run()])
    setClientDownloadClaimant(googleSetupClientDownloadClaimant(deps))
    const stopWatching = vi.fn()
    try {
      expect(beginClientDownload('t3', start, stopWatching)).toBe(true)
      const disconnected = 'the desktop disconnected before the download finished.'
      expect(abortClaimedClientDownload('setup-page', 't3', disconnected)).toBe(true)
      await vi.waitFor(() =>
        expect(deps.keyRefused).toHaveBeenCalledExactlyOnceWith('ivy', disconnected)
      )
      expect(stopWatching).toHaveBeenCalledOnce()
      expect(deps.importKey).not.toHaveBeenCalled()
    } finally {
      setClientDownloadClaimant(null)
    }
  })
})
