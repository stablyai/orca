import { LinuxLidSleepAssertion } from './linux-lid-sleep-assertion'
import { MacosSystemSleepAssertion } from './macos-system-sleep-assertion'

type PowerSaveBlocker = {
  start: (type: 'prevent-app-suspension' | 'prevent-display-sleep') => number
  stop: (id: number) => void
  isStarted: (id: number) => boolean
}

type PlatformAwakeAssertion = {
  start: (reason: string) => void
  stop: (reason: string) => void
  dispose: () => void
}

type PowerMonitorEventSource = {
  on: (event: 'resume', listener: () => void) => void
  off: (event: 'resume', listener: () => void) => void
}

type Logger = Pick<Console, 'debug' | 'warn'>

type BrowserScreencastAwakeServiceOptions = {
  blocker?: PowerSaveBlocker
  linuxAssertion?: PlatformAwakeAssertion
  logger?: Logger
  macosAssertion?: PlatformAwakeAssertion
  powerMonitor?: PowerMonitorEventSource | null
}

type ElectronPowerApis = {
  powerMonitor: PowerMonitorEventSource
  powerSaveBlocker: PowerSaveBlocker
}

// Why: keep this module importable under incomplete `vi.mock('electron')` fixtures
// used by orca-runtime tests. Resolve Electron power APIs only when constructing.
function loadElectronPowerApis(): ElectronPowerApis {
  // Why: lazy CJS resolve avoids static electron named-import mock breakage in orca-runtime tests.
  return require('electron') as ElectronPowerApis
}

/**
 * Keeps the display/compositor awake while any browser.screencast stream is live.
 *
 * Why: mobile/remote browser panes consume CDP screencast frames from the host
 * Chromium. Display sleep and occlusion park the compositor, so frames stop even
 * though the main process, PTYs, and guest `setBackgroundThrottling(false)` stay
 * healthy. Gate the same prevent-display-sleep path agents use on active
 * screencast subscriptions so idle hosts still save power.
 */
export class BrowserScreencastAwakeService {
  private readonly activeTokens = new Set<string>()
  private blockerId: number | null = null
  private readonly blocker: PowerSaveBlocker
  private readonly linuxAssertion: PlatformAwakeAssertion
  private readonly logger: Logger
  private readonly macosAssertion: PlatformAwakeAssertion
  private readonly unsubscribeResume: (() => void) | null

  constructor(options: BrowserScreencastAwakeServiceOptions = {}) {
    this.logger = options.logger ?? console
    const electronApis =
      options.blocker !== undefined && options.powerMonitor !== undefined
        ? null
        : loadElectronPowerApis()
    this.blocker = options.blocker ?? electronApis!.powerSaveBlocker
    // Windows lid close is intentionally not modeled as an assertion here:
    // keeping it awake requires mutating the user's global power plan.
    this.linuxAssertion =
      options.linuxAssertion ??
      new LinuxLidSleepAssertion({
        logger: this.logger,
        onUnexpectedFailure: (reason) => this.refresh(reason)
      })
    this.macosAssertion =
      options.macosAssertion ??
      new MacosSystemSleepAssertion({
        logger: this.logger,
        onUnexpectedFailure: (reason) => this.refresh(reason)
      })
    const resumeSource =
      options.powerMonitor !== undefined ? options.powerMonitor : electronApis!.powerMonitor
    if (resumeSource) {
      const onResume = () => this.refresh('power-resume')
      resumeSource.on('resume', onResume)
      this.unsubscribeResume = () => resumeSource.off('resume', onResume)
    } else {
      this.unsubscribeResume = null
    }
  }

  acquire(token: string): void {
    if (!token || this.activeTokens.has(token)) {
      return
    }
    this.activeTokens.add(token)
    this.refresh('screencast-acquire')
  }

  release(token: string): void {
    if (!token || !this.activeTokens.delete(token)) {
      return
    }
    this.refresh('screencast-release')
  }

  getActiveCount(): number {
    return this.activeTokens.size
  }

  dispose(): void {
    this.unsubscribeResume?.()
    this.activeTokens.clear()
    this.stopBlocker('dispose')
    this.macosAssertion.dispose()
    this.linuxAssertion.dispose()
  }

  private refresh(reason: string): void {
    const activeCount = this.activeTokens.size
    if (activeCount > 0) {
      this.startBlocker(reason, activeCount)
      this.startMacosAssertion(reason)
      this.startLinuxAssertion(reason)
    } else {
      this.stopBlocker(reason, activeCount)
      this.stopMacosAssertion(reason)
      this.stopLinuxAssertion(reason)
    }
  }

  private startBlocker(reason: string, activeCount: number): void {
    if (this.blockerId !== null) {
      if (this.reconcileBlocker('start-reconcile')) {
        return
      }
    }
    try {
      const id = this.blocker.start('prevent-display-sleep')
      this.blockerId = id
      this.reconcileBlocker('post-start')
    } catch (err) {
      this.logger.warn('[browser-screencast-awake] failed to start blocker', {
        reason,
        activeCount,
        error: err
      })
    }
  }

  private startMacosAssertion(reason: string): void {
    try {
      this.macosAssertion.start(reason)
    } catch (err) {
      this.logger.warn('[browser-screencast-awake] failed to start macOS system sleep assertion', {
        reason,
        error: err
      })
    }
  }

  private startLinuxAssertion(reason: string): void {
    try {
      this.linuxAssertion.start(reason)
    } catch (err) {
      this.logger.warn('[browser-screencast-awake] failed to start Linux lid sleep assertion', {
        reason,
        error: err
      })
    }
  }

  private stopMacosAssertion(reason: string): void {
    try {
      this.macosAssertion.stop(reason)
    } catch (err) {
      this.logger.warn('[browser-screencast-awake] failed to stop macOS system sleep assertion', {
        reason,
        error: err
      })
    }
  }

  private stopLinuxAssertion(reason: string): void {
    try {
      this.linuxAssertion.stop(reason)
    } catch (err) {
      this.logger.warn('[browser-screencast-awake] failed to stop Linux lid sleep assertion', {
        reason,
        error: err
      })
    }
  }

  private stopBlocker(reason: string, activeCount = 0): void {
    if (this.blockerId === null) {
      return
    }
    const id = this.blockerId
    // Why: clear before reconcile so a flaky isStarted() after a successful stop
    // cannot strand a stale id and skip the next startBlocker.
    this.blockerId = null
    try {
      this.blocker.stop(id)
    } catch (err) {
      this.logger.warn('[browser-screencast-awake] failed to stop blocker', {
        reason,
        activeCount,
        blockerId: id,
        error: err
      })
    }
  }

  private reconcileBlocker(reason: string): boolean {
    if (this.blockerId === null) {
      return false
    }
    const id = this.blockerId
    try {
      const isStarted = this.blocker.isStarted(id)
      if (!isStarted) {
        this.blockerId = null
      }
      return isStarted
    } catch (err) {
      this.logger.warn('[browser-screencast-awake] failed to reconcile blocker', {
        reason,
        blockerId: id,
        error: err
      })
      return true
    }
  }
}

let sharedBrowserScreencastAwakeService: BrowserScreencastAwakeService | null = null

export function getBrowserScreencastAwakeService(): BrowserScreencastAwakeService {
  sharedBrowserScreencastAwakeService ??= new BrowserScreencastAwakeService()
  return sharedBrowserScreencastAwakeService
}

export function disposeBrowserScreencastAwakeService(): void {
  sharedBrowserScreencastAwakeService?.dispose()
  sharedBrowserScreencastAwakeService = null
}
