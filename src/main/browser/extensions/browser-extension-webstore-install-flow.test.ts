import { describe, expect, it, vi } from 'vitest'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import {
  CHROME_WEB_STORE_APPROVAL_TTL_MS,
  ChromeWebStoreInstallFlow,
  InvalidIconUrlError,
  chromeWebStoreExtensionStatus,
  type ChromeWebStoreFrame,
  type ChromeWebStoreInstallFlowDeps
} from './browser-extension-webstore-install-flow'

const ID = 'nngceckbapebfimnlniiiahkandclblb'
const MANIFEST = JSON.stringify({
  name: '__MSG_extName__',
  version: '2026.1.0',
  manifest_version: 3,
  permissions: ['tabs', 'storage'],
  host_permissions: ['https://*/*']
})

function installed(): InstalledBrowserExtension {
  return {
    id: ID,
    name: 'Bitwarden',
    version: '2026.1.0',
    path: '/x',
    source: 'webstore',
    iconPath: null,
    permissions: [],
    hostPermissions: [],
    optionsPage: null
  }
}

function setup(overrides: Partial<ChromeWebStoreInstallFlowDeps> = {}) {
  let now = 1_000
  let answer = true
  const deps: ChromeWebStoreInstallFlowDeps = {
    now: () => now,
    isEnabledInProfile: () => false,
    isBusy: () => false,
    profileLabel: () => 'Work',
    loadIcon: vi.fn(async () => 'data:image/png;base64,AA=='),
    confirm: vi.fn(async () => answer),
    install: vi.fn(async () => installed()),
    describeInstalled: vi.fn(async () => ({ name: 'Bitwarden', iconDataUrl: null })),
    uninstall: vi.fn(async () => {}),
    notifyInstalled: vi.fn(),
    notifyUninstalled: vi.fn(),
    ...overrides
  }
  const valid = { current: true }
  const frame: ChromeWebStoreFrame = {
    webContentsId: 7,
    frameTreeNodeId: 3,
    profileId: 'work',
    isStillValid: () => valid.current
  }
  return {
    deps,
    frame,
    valid,
    flow: new ChromeWebStoreInstallFlow(deps),
    advance: (ms: number) => {
      now += ms
    },
    decline: () => {
      answer = false
    }
  }
}

const details = {
  id: ID,
  manifest: MANIFEST,
  localizedName: 'Bitwarden',
  iconUrl: 'https://lh3.googleusercontent.com/x'
}

describe('ChromeWebStoreInstallFlow.begin', () => {
  it('asks the user with the listing name, icon and access, then approves', async () => {
    const { flow, frame, deps } = setup()

    await expect(flow.begin(frame, details)).resolves.toEqual({ value: '' })
    expect(deps.confirm).toHaveBeenCalledWith(frame, {
      kind: 'install',
      name: 'Bitwarden',
      iconDataUrl: 'data:image/png;base64,AA==',
      permissions: ['storage', 'tabs'],
      hostPermissions: ['https://*/*'],
      profileLabel: 'Work'
    })
  })

  it.each([
    [
      { ...details, id: 'not-an-id' },
      { value: 'invalid_id', error: 'Invalid id' }
    ],
    [
      { ...details, manifest: '{' },
      { value: 'manifest_error', error: 'Invalid manifest' }
    ],
    [
      { ...details, manifest: JSON.stringify({ name: 'x', version: '1', manifest_version: 2 }) },
      { value: 'manifest_error', error: 'Manifest version 2 is no longer supported' }
    ],
    [
      {
        ...details,
        manifest: JSON.stringify({ name: 'x', version: '1', manifest_version: 3, theme: {} })
      },
      { value: 'unsupported_extension_type', error: 'Orca can install extensions only' }
    ]
  ])('refuses bad input without prompting', async (input, reply) => {
    const { flow, frame, deps } = setup()
    await expect(flow.begin(frame, input)).resolves.toEqual(reply)
    expect(deps.confirm).not.toHaveBeenCalled()
  })

  it('reports an extension already on in this profile', async () => {
    const { flow, frame } = setup({ isEnabledInProfile: () => true })
    await expect(flow.begin(frame, details)).resolves.toEqual({
      value: 'already_installed',
      error: 'This item is already installed'
    })
  })

  it('separates a disallowed icon URL from an icon that failed to load', async () => {
    const invalid = setup({
      loadIcon: async () => {
        throw new InvalidIconUrlError('Invalid icon url')
      }
    })
    const broken = setup({
      loadIcon: async () => {
        throw new Error('404')
      }
    })
    await expect(invalid.flow.begin(invalid.frame, details)).resolves.toMatchObject({
      value: 'invalid_icon_url'
    })
    await expect(broken.flow.begin(broken.frame, details)).resolves.toMatchObject({
      value: 'icon_error'
    })
  })

  it('reports user_cancelled when the user declines', async () => {
    const { flow, frame, decline, deps } = setup()
    decline()
    await expect(flow.begin(frame, details)).resolves.toEqual({
      value: 'user_cancelled',
      error: 'User cancelled install'
    })
    await expect(flow.complete(frame, ID)).resolves.toEqual({
      error: `${ID} does not match a previous call to beginInstallWithManifest3`
    })
    expect(deps.install).not.toHaveBeenCalled()
  })

  it('cancels when the tab navigated away while the prompt was open', async () => {
    const { flow, frame, valid, deps } = setup()
    vi.mocked(deps.confirm).mockImplementation(async () => {
      valid.current = false
      return true
    })
    await expect(flow.begin(frame, details)).resolves.toMatchObject({ value: 'user_cancelled' })
  })

  it('refuses a second begin while the first prompt is open', async () => {
    const answers: ((value: boolean) => void)[] = []
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => answers.push(resolve)))
    const { flow, frame } = setup({ confirm })
    const first = flow.begin(frame, details)
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    await expect(flow.begin(frame, details)).resolves.toMatchObject({
      value: 'install_in_progress'
    })
    answers[0](true)
    await expect(first).resolves.toEqual({ value: '' })
  })
})

describe('ChromeWebStoreInstallFlow.complete', () => {
  it('installs into the approving profile with the approved access, then raises onInstalled', async () => {
    const { flow, frame, deps } = setup()
    await flow.begin(frame, details)

    await expect(flow.complete(frame, ID)).resolves.toEqual({})
    expect(deps.install).toHaveBeenCalledWith(frame, ID, {
      permissions: ['storage', 'tabs'],
      hostPermissions: ['https://*/*']
    })
    expect(deps.notifyInstalled).toHaveBeenCalledWith(installed())
  })

  it('consumes the approval once', async () => {
    const { flow, frame } = setup()
    await flow.begin(frame, details)
    await flow.complete(frame, ID)
    await expect(flow.complete(frame, ID)).resolves.toHaveProperty('error')
  })

  it('refuses an approval that expired', async () => {
    const { flow, frame, advance, deps } = setup()
    await flow.begin(frame, details)
    advance(CHROME_WEB_STORE_APPROVAL_TTL_MS)
    await expect(flow.complete(frame, ID)).resolves.toEqual({
      error: `${ID} does not match a previous call to beginInstallWithManifest3`
    })
    expect(deps.install).not.toHaveBeenCalled()
  })

  it('refuses an approval granted to another frame or tab', async () => {
    const { flow, frame, deps } = setup()
    await flow.begin(frame, details)
    await expect(flow.complete({ ...frame, frameTreeNodeId: 4 }, ID)).resolves.toHaveProperty(
      'error'
    )
    await expect(flow.complete({ ...frame, webContentsId: 8 }, ID)).resolves.toHaveProperty('error')
    expect(deps.install).not.toHaveBeenCalled()
  })

  it('reports an install failure such as an access mismatch and refreshes the store button', async () => {
    const { flow, frame, deps } = setup({
      install: async () => {
        throw new Error('The downloaded extension asks for different access than the store listed')
      }
    })
    await flow.begin(frame, details)
    await expect(flow.complete(frame, ID)).resolves.toEqual({
      error: 'The downloaded extension asks for different access than the store listed'
    })
    expect(deps.notifyUninstalled).toHaveBeenCalledWith(ID)
    expect(deps.notifyInstalled).not.toHaveBeenCalled()
  })
})

describe('ChromeWebStoreInstallFlow.uninstall', () => {
  it('always asks before removing', async () => {
    const { flow, frame, deps } = setup()
    await expect(flow.uninstall(frame, ID)).resolves.toEqual({})
    expect(deps.confirm).toHaveBeenCalledWith(frame, expect.objectContaining({ kind: 'uninstall' }))
    expect(deps.uninstall).toHaveBeenCalledWith(ID)
  })

  it('reports Chrome’s cancel message when declined', async () => {
    const { flow, frame, decline, deps } = setup()
    decline()
    await expect(flow.uninstall(frame, ID)).resolves.toEqual({
      error: `Extension ${ID} uninstall canceled by user.`
    })
    expect(deps.uninstall).not.toHaveBeenCalled()
  })

  it('reports an unknown extension', async () => {
    const { flow, frame } = setup({ describeInstalled: async () => null })
    await expect(flow.uninstall(frame, ID)).resolves.toEqual({
      error: `Failed to find extension with id ${ID}.`
    })
  })
})

describe('chromeWebStoreExtensionStatus', () => {
  it('reports enabled, deprecated or installable', () => {
    expect(chromeWebStoreExtensionStatus(true, null)).toBe('enabled')
    expect(chromeWebStoreExtensionStatus(false, MANIFEST)).toBe('installable')
    expect(chromeWebStoreExtensionStatus(false, null)).toBe('installable')
    expect(
      chromeWebStoreExtensionStatus(
        false,
        JSON.stringify({ name: 'x', version: '1', manifest_version: 2 })
      )
    ).toBe('deprecated_manifest_version')
  })
})
