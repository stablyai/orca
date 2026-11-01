import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'

const ID = 'nngceckbapebfimnlniiiahkandclblb'

const mocks = vi.hoisted(() => ({
  enabled: new Map<string, string[]>(),
  prepare: vi.fn(async () => {}),
  load: vi.fn(async (_profileId: string): Promise<unknown> => ({}))
}))

vi.mock('../browser-session-registry', () => ({
  browserSessionRegistry: {
    listProfiles: () => [...mocks.enabled.keys()].map((id) => ({ id })),
    getEnabledExtensionIds: (profileId: string) => mocks.enabled.get(profileId) ?? []
  }
}))
vi.mock('./browser-extension-load-directory', () => ({
  prepareBrowserExtensionDirectory: mocks.prepare
}))
vi.mock('./browser-extension-session-loader', () => ({
  getBrowserExtensionSessionForProfile: () => ({}),
  loadBrowserExtensionIntoProfile: mocks.load,
  unloadBrowserExtensionFromProfile: vi.fn()
}))

const { reloadBrowserExtensionWhereEnabled } = await import('./browser-extension-profile-reload')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reload reads only the id and passes the record through.
const extension = { id: ID } as InstalledBrowserExtension

function disable(profileId: string): void {
  mocks.enabled.set(profileId, [])
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.enabled = new Map([
    ['default', [ID]],
    ['work', [ID]]
  ])
})

describe('reloadBrowserExtensionWhereEnabled', () => {
  it('does not start the extension in a profile that turned it off during the copy', async () => {
    mocks.prepare.mockImplementationOnce(async () => disable('default'))
    await reloadBrowserExtensionWhereEnabled(extension, { refresh: true })
    expect(mocks.load.mock.calls.map(([profileId]) => profileId)).toEqual(['work'])
  })

  it("still reloads other profiles when turning it off cancels one profile's load", async () => {
    mocks.load.mockImplementationOnce(async () => {
      disable('default')
      throw new Error('The extension was turned off before it finished loading')
    })
    await expect(reloadBrowserExtensionWhereEnabled(extension)).resolves.toBeUndefined()
    expect(mocks.load.mock.calls.map(([profileId]) => profileId)).toEqual(['default', 'work'])
  })
})
