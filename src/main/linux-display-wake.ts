import { spawn as nodeSpawn } from 'node:child_process'

type Logger = Pick<Console, 'debug' | 'warn'>

type WakeSpawn = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: true; shell?: false; env?: NodeJS.ProcessEnv }
) => { unref?: () => void }

type LinuxDisplayWakeOptions = {
  env?: NodeJS.ProcessEnv
  logger?: Logger
  platform?: NodeJS.Platform
  spawn?: WakeSpawn
}

/** Best-effort DPMS on when a DISPLAY is available; no-op without X. */
export function wakeLinuxDisplay(options: LinuxDisplayWakeOptions = {}): void {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux') {
    return
  }
  const env = options.env ?? process.env
  if (!env.DISPLAY) {
    return
  }
  const logger = options.logger ?? console
  const spawn = options.spawn ?? nodeSpawn
  try {
    const child = spawn('xset', ['dpms', 'force', 'on'], {
      stdio: 'ignore',
      windowsHide: true,
      env
    })
    child.unref?.()
  } catch (error) {
    logger.debug('[browser-screencast-awake] failed to wake Linux display', { error })
  }
}
