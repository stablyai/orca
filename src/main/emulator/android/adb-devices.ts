export type AndroidAdbDeviceState =
  | 'device'
  | 'offline'
  | 'unauthorized'
  | 'bootloader'
  | 'recovery'
  | 'no permissions'
  | (string & {})

export type AndroidAdbDevice = {
  serial: string
  state: AndroidAdbDeviceState
  isEmulator: boolean
  model?: string
  product?: string
}

const DEVICES_HEADER = 'List of devices attached'

export function parseAdbDevices(stdout: string): AndroidAdbDevice[] {
  const devices: AndroidAdbDevice[] = []

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line === DEVICES_HEADER) {
      continue
    }

    const tokens = line.split(/\s+/)
    const serial = tokens[0]
    if (!serial) {
      continue
    }

    // "no permissions" occupies two state tokens before the key:value metadata.
    let state: AndroidAdbDeviceState
    let tokenStart: number
    if (tokens[1] === 'no' && tokens[2] === 'permissions') {
      state = 'no permissions'
      tokenStart = 3
    } else {
      state = tokens[1] ?? ''
      tokenStart = 2
    }

    const device: AndroidAdbDevice = {
      serial,
      state,
      isEmulator: serial.startsWith('emulator-')
    }

    for (const token of tokens.slice(tokenStart)) {
      const sep = token.indexOf(':')
      if (sep === -1) {
        continue
      }
      const key = token.slice(0, sep)
      const value = token.slice(sep + 1)
      if (key === 'model') {
        device.model = value
      } else if (key === 'product') {
        device.product = value
      }
    }

    devices.push(device)
  }

  return devices
}

// Override size is the active resolution when both sizes are reported.
export function parseWmSize(stdout: string): { width: number; height: number } | null {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(stdout)
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(stdout)
  const match = override ?? physical
  if (!match) {
    return null
  }
  return { width: Number(match[1]), height: Number(match[2]) }
}

export function isBootCompleted(getpropStdout: string): boolean {
  return getpropStdout.trim() === '1'
}

export const adbDevicesArgs: readonly string[] = ['devices', '-l']

export function adbShellArgs(serial: string, command: readonly string[]): string[] {
  return ['-s', serial, 'shell', ...command]
}

export function wmSizeArgs(serial: string): string[] {
  return adbShellArgs(serial, ['wm', 'size'])
}

export function bootCompletedArgs(serial: string): string[] {
  return adbShellArgs(serial, ['getprop', 'sys.boot_completed'])
}
