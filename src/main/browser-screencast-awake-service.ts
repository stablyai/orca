import { LinuxLidSleepAssertion } from './linux-lid-sleep-assertion'
import { wakeLinuxDisplay } from './linux-display-wake'
import { wakeMacosDisplay } from './macos-display-wake'
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
  wakeDisplay?: (reason: string) => void
}

type ElectronPowerApis = {
  powerMonitor: PowerMonitorEventSource
  powerSaveBlocker: PowerSaveBlocker
}

function loadElectronPowerApis(): ElectronPowerApis {
  // Why: incomplete vi.mock('electron') fixtures must still load this module.
  return require('electron') as ElectronPowerApis
}

/** Wake-on-demand + hold display awake while browser.screencast needs CDP frames. */
export class BrowserScreencastAwakeService {
  private readonly activeTokens = new Set<string>()
  private blockerId: number | null = null
  private readonly blocker: PowerSaveBlocker
  private readonly linuxAssertion: PlatformAwakeAssertion
  private readonly logger: Logger
  private readonly macosAssertion: PlatformAwakeAssertion
  private readonly wakeDisplay: (reason: string) => void
  private readonly unsubscribeResume: (() => void) | null

  constructor(options: BrowserScreencastAwakeServiceOptions = {}) {
    this.logger = options.logger ?? console
    this.wakeDisplay =
      options.wakeDisplay ??
      ((reason) => {
        wakeMacosDisplay({ logger: this.logger })
        wakeLinuxDisplay({ logger: this.logger })
        this.logger.debug('[browser-screencast-awake] wake-on-demand', { reason })
      })
    const electronApis =
      options.blocker !== undefined && options.powerMonitor !== undefined
        ? null
        : loadElectronPowerApis()
    this.blocker = options.blocker ?? electronApis!.powerSaveBlocker
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
      options.powerMonitor === undefined ? electronApis!.powerMonitor : options.powerMonitor
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
    const becomingActive = this.activeTokens.size === 0
    this.activeTokens.add(token)
    if (becomingActive) {
      // Why: prevent-display-sleep alone does not turn an already-sleeping display back on.
      this.wakeDisplay('screencast-start')
    }
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
      this.runAssertion('start', this.macosAssertion, reason, 'macOS system sleep assertion')
      this.runAssertion('start', this.linuxAssertion, reason, 'Linux lid sleep assertion')
    } else {
      this.stopBlocker(reason, activeCount)
      this.runAssertion('stop', this.macosAssertion, reason, 'macOS system sleep assertion')
      this.runAssertion('stop', this.linuxAssertion, reason, 'Linux lid sleep assertion')
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

  private runAssertion(
    action: 'start' | 'stop',
    assertion: PlatformAwakeAssertion,
    reason: string,
    label: string
  ): void {
    try {
      assertion[action](reason)
    } catch (err) {
      this.logger.warn(`[browser-screencast-awake] failed to ${action} ${label}`, {
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
    // Why: clear before stop so a flaky isStarted() cannot strand a stale id.
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
