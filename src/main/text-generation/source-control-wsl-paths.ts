import { parseWslUncPath, wslUncPathToLinux } from '../../shared/wsl-paths'
import { runWslProcess } from '../wsl/execution/wsl-runner'

export async function sourceControlWslPath(
  value: string,
  distro: string,
  signal: AbortSignal
): Promise<string> {
  return (await sourceControlWslPaths([value], distro, signal))[0]
}

export async function sourceControlWslPaths(
  values: string[],
  distro: string,
  signal: AbortSignal
): Promise<string[]> {
  signal.throwIfAborted()
  const paths = values.map((value) => {
    if (parseWslUncPath(value)) {
      const guest = wslUncPathToLinux(value, distro)
      if (guest === null) {
        throw new Error('Text task path belongs to another WSL distro')
      }
      return guest
    }
    return value
  })
  const drives = paths.filter((value) => /^[A-Za-z]:[/\\]/.test(value))
  if (!drives.length) {
    return paths
  }
  const result = await runWslProcess({
    distro,
    ...(drives.length === 1
      ? { program: 'wslpath', args: ['-a', '-u', drives[0]] }
      : {
          script: 'for value do wslpath -a -u "$value" || exit; done',
          args: drives
        }),
    loginPath: 'none',
    signal,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  })
  signal.throwIfAborted()
  const guests = result.stdout.replace(/\r?\n$/, '').split(/\r?\n/)
  if (
    result.code !== 0 ||
    result.timedOut ||
    result.outputTruncated ||
    guests.length !== drives.length ||
    guests.some((guest) => !guest.startsWith('/') || /[\r\n\0]/.test(guest))
  ) {
    throw new Error('Text task path could not be resolved in WSL')
  }
  let driveIndex = 0
  return paths.map((value) => (/^[A-Za-z]:[/\\]/.test(value) ? guests[driveIndex++] : value))
}
