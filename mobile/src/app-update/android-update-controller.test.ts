import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAndroidUpdateController,
  type AndroidUpdateDriver,
  type AndroidUpdateProgress
} from './android-update-controller'

const page = 'https://github.com/stablyai/orca/releases/tag/mobile-android-v0.0.58'
const asset = {
  version: '0.0.58',
  url: page.replace('/tag/', '/download/') + '/app-release.apk',
  size: 100,
  sha256: 'a'.repeat(64)
}
function deferred() {
  let resolve = () => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup() {
  let progress = (_value: AndroidUpdateProgress) => {}
  const transfer = deferred()
  const driver: AndroidUpdateDriver = {
    prepare: vi.fn(() => transfer.promise),
    cancel: vi.fn(),
    install: vi.fn(async () => 'installer' as const),
    canInstall: vi.fn(() => true),
    addListener: (_event, listener) => {
      progress = listener
      return { remove: vi.fn() }
    }
  }
  const load = vi.fn(async (_url: string, _signal: AbortSignal) => asset)
  const controller = createAndroidUpdateController(driver, load)
  controller.open(asset.version, page)
  return {
    controller,
    driver,
    load,
    transfer,
    emit: (value: AndroidUpdateProgress) => progress(value)
  }
}
afterEach(() => vi.useRealTimers())

describe('Android in-app update lifecycle', () => {
  it('does not download on open; keeps a single transfer alive while hidden and reopened', async () => {
    const { controller, driver, transfer, emit } = setup()
    expect(controller.getSnapshot()?.phase).toBe('available')
    expect(driver.prepare).not.toHaveBeenCalled()
    const download = controller.download()
    await Promise.resolve()
    controller.hide()
    emit({ downloaded: 42, total: 100, verifying: false })
    expect(controller.getSnapshot()).toMatchObject({
      visible: false,
      downloaded: 42,
      phase: 'downloading'
    })
    controller.open(asset.version, page)
    await controller.download()
    expect(driver.prepare).toHaveBeenCalledTimes(1)
    emit({ downloaded: 100, total: 100, verifying: true })
    expect(controller.getSnapshot()?.phase).toBe('verifying')
    transfer.resolve()
    await download
    expect(controller.getSnapshot()).toMatchObject({
      visible: true,
      phase: 'ready',
      downloaded: 100
    })
    expect(driver.install).not.toHaveBeenCalled()
  })

  it('cancels without surfacing a download error and allows a fresh retry', async () => {
    const { controller, driver, transfer } = setup()
    vi.mocked(driver.cancel).mockImplementation(() => transfer.reject(new Error('cancelled')))
    const download = controller.download()
    await Promise.resolve()
    controller.cancel()
    await download
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'available',
      downloaded: 0,
      error: null
    })
    vi.mocked(driver.prepare).mockResolvedValue()
    await controller.download()
    expect(controller.getSnapshot()?.phase).toBe('ready')
  })

  it('does not resurrect cancelled metadata work when a late result arrives', async () => {
    const { controller, driver, load } = setup()
    const metadata = deferred()
    load.mockImplementationOnce(async () => {
      await metadata.promise
      return asset
    })
    const download = controller.download()
    controller.cancel()
    metadata.resolve()
    await download
    expect(controller.getSnapshot()?.phase).toBe('available')
    expect(driver.prepare).not.toHaveBeenCalled()
  })

  it('keeps verification failures actionable instead of offering installation', async () => {
    const { controller, transfer } = setup()
    const download = controller.download()
    transfer.reject(new Error('The APK uses a different signing certificate.'))
    await download
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'The APK uses a different signing certificate.',
      releaseUrl: page
    })
  })

  it('continues into the installer only when install-source permission has been granted', async () => {
    const { controller, driver, transfer } = setup()
    transfer.resolve()
    await controller.download()
    vi.mocked(driver.install).mockResolvedValueOnce('permission')
    await controller.install()
    expect(controller.getSnapshot()?.phase).toBe('permission')
    vi.mocked(driver.canInstall).mockReturnValue(false)
    controller.foreground()
    expect(driver.install).toHaveBeenCalledTimes(1)
    vi.mocked(driver.canInstall).mockReturnValue(true)
    controller.foreground()
    await vi.waitFor(() => expect(controller.getSnapshot()?.phase).toBe('ready'))
    expect(driver.install).toHaveBeenCalledTimes(2)
    controller.foreground()
    expect(driver.install).toHaveBeenCalledTimes(2)
  })

  it('aborts a stalled metadata request and exposes a retry', async () => {
    vi.useFakeTimers()
    const { controller, load } = setup()
    load.mockImplementationOnce(
      (_url, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Request timed out')))
        })
    )
    const download = controller.download()
    await vi.advanceTimersByTimeAsync(15_000)
    await download
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Could not reach GitHub. Check your connection and try again.'
    })
  })

  it('does not reopen the installer after the owner dismisses the permission step', async () => {
    const { controller, driver, transfer } = setup()
    transfer.resolve()
    await controller.download()
    vi.mocked(driver.install).mockResolvedValueOnce('permission')
    await controller.install()
    controller.hide()
    controller.foreground()
    expect(controller.getSnapshot()).toMatchObject({ visible: false, phase: 'permission' })
    expect(driver.install).toHaveBeenCalledTimes(1)
    controller.open(asset.version, page)
    await controller.install()
    expect(controller.getSnapshot()?.phase).toBe('ready')
  })
})
