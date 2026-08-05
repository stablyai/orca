import { spawn as nodeSpawn } from 'node:child_process'

type Logger = Pick<Console, 'debug' | 'warn'>

type WakeSpawn = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: true; shell?: false }
) => { unref?: () => void }

type MacosDisplayWakeOptions = {
  logger?: Logger
  platform?: NodeJS.Platform
  spawn?: WakeSpawn
  // Why: caffeinate -u default is 5s; keep the pulse short — prevent-display-sleep holds after.
  timeoutSeconds?: number
}

/** Turns the display on when already asleep (IOPMAssertionDeclareUserActivity via caffeinate -u). */
export function wakeMacosDisplay(options: MacosDisplayWakeOptions = {}): void {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    return
  }
  const logger = options.logger ?? console
  const spawn = options.spawn ?? nodeSpawn
  const timeoutSeconds = Math.max(1, options.timeoutSeconds ?? 5)
  try {
    const child = spawn('/usr/bin/caffeinate', ['-u', `-t`, String(timeoutSeconds)], {
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref?.()
  } catch (error) {
    logger.warn('[browser-screencast-awake] failed to wake macOS display', { error })
  }
}
