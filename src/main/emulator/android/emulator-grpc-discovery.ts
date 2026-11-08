import { lstat, readFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

export type EmulatorGrpcEndpoint = { address: string; token: string }

/** Registration paths belong to the local SDK user; remote emulators use scrcpy instead. */
export function emulatorRegistrationDirectories(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running')]
  }
  if (process.platform === 'win32') {
    return [
      join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Temp', 'avd', 'running')
    ]
  }
  return [
    ...(process.env.XDG_RUNTIME_DIR ? [process.env.XDG_RUNTIME_DIR] : []),
    join('/run', 'user', String(userInfo().uid)),
    join(home, '.android'),
    join(tmpdir(), `android-${userInfo().username}`)
  ].map((directory) => join(directory, 'avd', 'running'))
}

/** Only token-authenticated loopback registrations for the requested serial are eligible. */
export function parseEmulatorRegistration(
  text: string,
  serial: string
): EmulatorGrpcEndpoint | null {
  const values = new Map(
    text.split(/\r?\n/).map((line) => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)]
    })
  )
  const port = Number(values.get('grpc.port'))
  const token = values.get('grpc.token')
  if (
    `emulator-${values.get('port.serial')}` !== serial ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !token ||
    !/^[\x21-\x7e]+$/.test(token) ||
    values.has('grpc.certificate')
  ) {
    return null
  }
  return { address: `127.0.0.1:${port}`, token }
}

/** Missing, stale, or unsafe registrations return null so callers can use scrcpy. */
export async function discoverEmulatorGrpc(serial: string): Promise<EmulatorGrpcEndpoint | null> {
  if (!/^emulator-\d+$/.test(serial)) {
    return null
  }
  const { readdir } = await import('node:fs/promises')
  for (const directory of emulatorRegistrationDirectories()) {
    try {
      const parent = await lstat(directory)
      if (!parent.isDirectory() || !owned(parent)) {
        continue
      }
      for (const file of await readdir(directory)) {
        const match = /^pid_(\d+)(?:_info)?\.ini$/.exec(file)
        if (!match) {
          continue
        }
        try {
          const path = join(directory, file)
          const stat = await lstat(path)
          if (!stat.isFile() || !owned(stat) || stat.size > 64 * 1024) {
            continue
          }
          process.kill(Number(match[1]), 0)
          const endpoint = parseEmulatorRegistration(await readFile(path, 'utf8'), serial)
          if (endpoint) {
            return endpoint
          }
        } catch {
          /* A registration may disappear during emulator shutdown. */
        }
      }
    } catch {
      /* Try the next platform registration location. */
    }
  }
  return null
}

/** Unix registration files must belong to this user and exclude group/world writes. */
function owned(stat: { uid: number; mode: number }): boolean {
  return process.platform === 'win32' || (stat.uid === userInfo().uid && (stat.mode & 0o022) === 0)
}
