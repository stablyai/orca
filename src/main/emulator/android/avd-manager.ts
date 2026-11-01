export const listAvdsArgs: readonly string[] = ['-list-avds']

// Match log prefixes rather than substrings so names such as PixelWARNINGTest survive.
const EMULATOR_LOG_PREFIX = /^(INFO|WARNING|ERROR|DEBUG|VERBOSE|PANIC)\s/

function isNoiseLine(line: string): boolean {
  return line === '' || line.startsWith('No AVD') || EMULATOR_LOG_PREFIX.test(line)
}

export function parseAvdList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !isNoiseLine(line))
}

export type BootAvdOptions = {
  noSnapshot?: boolean
  noWindow?: boolean
  noBootAnim?: boolean
  gpu?: string
}

export function bootAvdArgs(name: string, options: BootAvdOptions = {}): string[] {
  const args = ['-avd', name]
  if (options.noSnapshot) {
    args.push('-no-snapshot')
  }
  if (options.noWindow) {
    args.push('-no-window')
  }
  if (options.noBootAnim) {
    args.push('-no-boot-anim')
  }
  if (options.gpu) {
    args.push('-gpu', options.gpu)
  }
  return args
}

export function emuKillArgs(serial: string): string[] {
  return ['-s', serial, 'emu', 'kill']
}
