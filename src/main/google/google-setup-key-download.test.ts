import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { StandingDownloadClaim } from '../browser/guest-lifecycle/manager/downloads/browser-manager-download-creation'
import type { GoogleSetupRun } from '../../shared/google/google-setup-run'
import {
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

function setup(runs: GoogleSetupRun[]) {
  const deps = {
    runs: () => runs,
    importKey: vi.fn(),
    keyArrived: vi.fn(async () => {}),
    keyRefused: vi.fn(async () => {})
  }
  return { claim: googleSetupKeyDownloadClaim(deps), deps }
}

const KEY = {
  browserTabId: 'setup-page',
  filename: 'client_secret_123.json',
  documentUrl: 'https://console.cloud.google.com/auth/clients?project=example-project-123'
}

async function download(taken: StandingDownloadClaim, text: string): Promise<void> {
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
  })

  it('saves the key, finishes client and deletes the file', async () => {
    const { claim, deps } = setup([run()])
    const taken = claim(KEY)!
    await download(taken, desktopKey())
    await vi.waitFor(() => expect(deps.keyArrived).toHaveBeenCalledWith('ivy'))
    expect(deps.importKey).toHaveBeenCalledWith(desktopKey())
    expect(existsSync(taken.savePath)).toBe(false)
  })

  it("refuses a key for another project without replacing the host's app", async () => {
    const { claim, deps } = setup([run()])
    const taken = claim(KEY)!
    await download(taken, desktopKey('someone-else'))
    await vi.waitFor(() => expect(deps.keyRefused).toHaveBeenCalled())
    expect(deps.keyRefused.mock.calls[0]).toEqual([
      'ivy',
      'the key is for project someone-else, not example-project-123.'
    ])
    expect(deps.importKey).not.toHaveBeenCalled()
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

  it("deletes a refused key's file before telling the bot, however long that takes", async () => {
    const { claim, deps } = setup([run()])
    const held = Promise.withResolvers<void>()
    deps.keyRefused.mockImplementation(() => held.promise)
    const taken = claim(KEY)!
    await download(taken, '{"web":{}}')
    await vi.waitFor(() => expect(deps.keyRefused).toHaveBeenCalled())
    expect(existsSync(taken.savePath)).toBe(false)
    held.resolve()
  })
})
