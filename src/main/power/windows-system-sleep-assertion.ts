import { powerSaveBlocker } from 'electron'

type Logger = Pick<Console, 'debug' | 'warn'>

type SystemSleepBlocker = {
  start: (type: 'prevent-app-suspension') => number
  stop: (id: number) => void
  isStarted: (id: number) => boolean
}

type WindowsSystemSleepAssertionOptions = {
  blocker?: SystemSleepBlocker
  logger?: Logger
  platform?: NodeJS.Platform
}

/** Keeps Windows out of idle sleep (ES_SYSTEM_REQUIRED) while letting the display turn off. */
export class WindowsSystemSleepAssertion {
  private readonly blocker: SystemSleepBlocker
  private readonly logger: Logger
  private readonly platform: NodeJS.Platform
  private blockerId: number | null = null

  constructor(options: WindowsSystemSleepAssertionOptions = {}) {
    this.blocker = options.blocker ?? powerSaveBlocker
    this.logger = options.logger ?? console
    this.platform = options.platform ?? process.platform
  }

  start(reason: string): boolean {
    if (this.platform !== 'win32') {
      return false
    }
    if (this.blockerId !== null && this.isStarted(this.blockerId)) {
      return true
    }
    try {
      this.blockerId = this.blocker.start('prevent-app-suspension')
      return this.isStarted(this.blockerId)
    } catch (error) {
      this.blockerId = null
      this.logger.warn('[agent-awake] Windows system sleep assertion failed', { reason, error })
      return false
    }
  }

  stop(_reason: string): void {
    if (this.blockerId === null) {
      return
    }
    const id = this.blockerId
    this.blockerId = null
    try {
      this.blocker.stop(id)
    } catch (error) {
      this.logger.warn('[agent-awake] failed to stop Windows system sleep assertion', { error })
    }
  }

  dispose(): void {
    this.stop('dispose')
  }

  private isStarted(id: number): boolean {
    try {
      return this.blocker.isStarted(id)
    } catch {
      return false
    }
  }
}
