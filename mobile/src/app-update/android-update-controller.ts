import type { AndroidUpdateAsset } from './android-update-release'

export type AndroidUpdatePhase =
  | 'available'
  | 'loading'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'ready'
  | 'permission'
  | 'error'
export type AndroidUpdateState = {
  visible: boolean
  version: string
  releaseUrl: string
  phase: AndroidUpdatePhase
  downloaded: number
  total: number
  error: string | null
}
export type AndroidUpdateProgress = { downloaded: number; total: number; verifying: boolean }

export type AndroidUpdateDriver = {
  prepare(asset: AndroidUpdateAsset): Promise<void>
  cancel(): void
  install(): Promise<'permission' | 'installer'>
  canInstall(): boolean
  addListener(
    event: 'onProgress',
    listener: (progress: AndroidUpdateProgress) => void
  ): { remove(): void }
}

export function createAndroidUpdateController(
  driver: AndroidUpdateDriver,
  loadAsset: (url: string, signal: AbortSignal) => Promise<AndroidUpdateAsset>
) {
  let state: AndroidUpdateState | null = null
  let task: Promise<void> | null = null
  let abort: AbortController | null = null
  let cancelled = false
  const listeners = new Set<() => void>()
  function publish(patch: Partial<AndroidUpdateState>) {
    if (state) {
      state = { ...state, ...patch }
      listeners.forEach((listener) => listener())
    }
  }
  function fail(error: unknown) {
    publish({
      phase: 'error',
      error:
        error instanceof Error
          ? error.message
          : 'Could not update Orca. Try again or open the release page.'
    })
  }
  async function install() {
    if (!state || task || !['ready', 'permission'].includes(state.phase)) {
      return
    }
    publish({ phase: 'installing', error: null })
    task = driver
      .install()
      .then((result) => {
        publish({ phase: result === 'permission' ? 'permission' : 'ready' })
      })
      .catch(fail)
      .finally(() => {
        task = null
      })
    await task
  }
  async function download() {
    if (!state || task) {
      return
    }
    cancelled = false
    abort = new AbortController()
    const signal = abort.signal
    const releaseUrl = state.releaseUrl
    publish({ phase: 'loading', downloaded: 0, total: 0, error: null })
    const timeout = setTimeout(() => abort?.abort(), 15_000)
    const progress = driver.addListener('onProgress', (value) => {
      if (!cancelled) {
        publish({
          downloaded: value.downloaded,
          total: value.total,
          phase: value.verifying ? 'verifying' : 'downloading'
        })
      }
    })
    task = (async () => {
      try {
        const asset = await loadAsset(releaseUrl, signal)
        clearTimeout(timeout)
        if (cancelled) {
          return
        }
        publish({ phase: 'downloading', total: asset.size })
        await driver.prepare(asset)
        if (!cancelled) {
          publish({ phase: 'ready', downloaded: asset.size })
        }
      } catch (error) {
        if (!cancelled) {
          fail(
            signal.aborted
              ? new Error('Could not reach GitHub. Check your connection and try again.')
              : error
          )
        }
      } finally {
        clearTimeout(timeout)
        progress.remove()
        abort = null
        task = null
        if (cancelled) {
          publish({ phase: 'available', downloaded: 0, total: 0 })
        }
      }
    })()
    await task
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open(version: string, releaseUrl: string) {
      if (state?.releaseUrl === releaseUrl || task) {
        publish({ visible: true })
        return
      }
      state = {
        visible: true,
        version,
        releaseUrl,
        phase: 'available',
        downloaded: 0,
        total: 0,
        error: null
      }
      listeners.forEach((listener) => listener())
    },
    hide() {
      publish({ visible: false })
    },
    download,
    install,
    cancel() {
      if (!abort) {
        return
      }
      cancelled = true
      abort.abort()
      driver.cancel()
    },
    foreground() {
      if (state?.phase === 'permission' && state.visible && driver.canInstall()) {
        void install()
      }
    }
  }
}
