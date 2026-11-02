import { expect, it, vi } from 'vitest'
import { updaterMainWindow } from '../updater-test-main-window'
import { LOCAL_BUILD_COMPATIBILITY_CONTRACT } from '../../shared/local-build-compatibility-contract'
import type { LocalBuildCandidate } from './local-build-candidate'

const { showOpenDialog, showMessageBox, loadCandidate } = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  loadCandidate: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.51' },
  dialog: { showOpenDialog, showMessageBox }
}))
vi.mock('./local-build-candidate', () => ({ loadLocalBuildCandidate: loadCandidate }))
vi.mock('./local-build-compatibility', () => ({
  assertLocalBuildCompatibility: async () => ({ liveTerminalCount: 0 })
}))
import { chooseLocalBuild } from './local-build-switch'

it('re-resolves dialog parents and preserves failure, cancellation and candidate handoff', async () => {
  let openOptions: unknown
  let confirmationOptions: unknown
  for (const { mode, outcome } of [
    { mode: 'live', outcome: 'reject' },
    { mode: 'headless', outcome: 'reject' },
    { mode: 'closed', outcome: 'cancel' },
    { mode: 'successor', outcome: 'confirm' }
  ] as const) {
    vi.resetAllMocks()
    showOpenDialog.mockResolvedValue({ filePaths: ['/tmp/local-build.yml'], canceled: false })
    let destroyed = false
    const oldWindow = Object.assign(updaterMainWindow(vi.fn()), {
      isDestroyed: () => destroyed
    })
    const successor = updaterMainWindow(vi.fn())
    let currentWindow = mode === 'headless' ? null : oldWindow
    const candidate: LocalBuildCandidate = {
      version: '1.0.52',
      compatibility: {
        ...LOCAL_BUILD_COMPATIBILITY_CONTRACT,
        readableStateSchemaVersions: [
          ...LOCAL_BUILD_COMPATIBILITY_CONTRACT.readableStateSchemaVersions
        ],
        attachableDaemonProtocolVersions: [
          ...LOCAL_BUILD_COMPATIBILITY_CONTRACT.attachableDaemonProtocolVersions
        ],
        buildId: 'local-test',
        version: '1.0.52',
        commit: 'test-commit',
        platform: 'darwin',
        architecture: 'arm64'
      },
      manifestContent: '',
      artifacts: new Map(),
      close: vi.fn(async () => {})
    }
    let finishLoading: (value: LocalBuildCandidate) => void = () => {}
    loadCandidate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoading = resolve
        })
    )
    const selection = chooseLocalBuild(() => currentWindow)
    await vi.waitFor(() => expect(loadCandidate).toHaveBeenCalledOnce())
    destroyed = mode !== 'live'
    if (mode === 'successor') {
      currentWindow = successor
    }
    const failure = new Error('Native confirmation failed')
    if (outcome === 'reject') {
      showMessageBox.mockRejectedValue(failure)
    } else {
      showMessageBox.mockResolvedValue({ response: outcome === 'confirm' ? 0 : 1 })
    }
    finishLoading(candidate)
    if (outcome === 'reject') {
      await expect(selection).rejects.toBe(failure)
    } else {
      expect(await selection).toBe(outcome === 'confirm' ? candidate : null)
    }
    expect(loadCandidate).toHaveBeenCalledExactlyOnceWith('/tmp/local-build.yml', process.arch)
    expect(candidate.close).toHaveBeenCalledTimes(outcome === 'confirm' ? 0 : 1)
    if (mode === 'live') {
      openOptions = showOpenDialog.mock.calls[0]?.at(-1)
      confirmationOptions = showMessageBox.mock.calls[0]?.at(-1)
      expect(openOptions).toMatchObject({ title: 'Choose a Local Orca Build' })
      expect(confirmationOptions).toMatchObject({ buttons: ['Use Local Build', 'Cancel'] })
    }
    expect(showOpenDialog).toHaveBeenCalledExactlyOnceWith(
      ...(mode === 'headless' ? [openOptions] : [oldWindow, openOptions])
    )
    expect(showMessageBox).toHaveBeenCalledExactlyOnceWith(
      ...(mode === 'successor'
        ? [successor, confirmationOptions]
        : mode === 'live'
          ? [oldWindow, confirmationOptions]
          : [confirmationOptions])
    )
  }
})
