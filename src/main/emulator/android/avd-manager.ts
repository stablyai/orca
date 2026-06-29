// `emulator -list-avds`
export const listAvdsArgs: readonly string[] = ['-list-avds']

// Emulator log lines look like `INFO    | ...` (marker + padding + pipe). AVD
// names contain no whitespace, so match the log prefix exactly rather than via
// substring — otherwise a name like `PixelWARNINGTest` would be dropped.
const EMULATOR_LOG_PREFIX = /^(INFO|WARNING|ERROR|DEBUG|VERBOSE|PANIC)\s/

function isNoiseLine(line: string): boolean {
  return line === '' || line.startsWith('No AVD') || EMULATOR_LOG_PREFIX.test(line)
}

// Parses `emulator -list-avds` stdout: one AVD name per line. Drops blank lines
// and informational/warning lines the emulator binary sometimes prints, trimming
// each kept name.
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

// Args to boot an AVD via the emulator binary: ['-avd', name] then any requested
// flags in a stable, documented order.
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

// `adb -s <serial> emu kill` to stop a running emulator instance.
export function emuKillArgs(serial: string): string[] {
  return ['-s', serial, 'emu', 'kill']
}
