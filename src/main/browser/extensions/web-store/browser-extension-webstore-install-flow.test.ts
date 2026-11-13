import { describe, expect, it, vi } from 'vitest'
import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import {
  ChromeWebStoreInstallFlow,
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

describe('ChromeWebStoreInstallFlow.complete', () => {
  it('consumes the approval once', async () => {
    const { flow, frame } = setup()
    await flow.begin(frame, details)
    await flow.complete(frame, ID)
    await expect(flow.complete(frame, ID)).resolves.toHaveProperty('error')
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
})
