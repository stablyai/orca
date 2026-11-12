import { parseWslUncPath, wslUncPathToLinux } from '../../shared/wsl-paths'
import { runWslProcess } from '../wsl/execution/wsl-runner'

export async function sourceControlWslPath(
  value: string,
  distro: string,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()
  if (parseWslUncPath(value)) {
    const guest = wslUncPathToLinux(value, distro)
    if (guest === null) {
      throw new Error('Text task path belongs to another WSL distro')
    }
    return guest
  }
  if (!/^[A-Za-z]:[/\\]/.test(value)) {
    return value
  }
  const result = await runWslProcess({
    distro,
    program: 'wslpath',
    args: ['-a', '-u', value],
    loginPath: 'none',
    signal,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  })
  signal.throwIfAborted()
  const guest = result.stdout.replace(/\r?\n$/, '')
  if (
    result.code !== 0 ||
    result.timedOut ||
    result.outputTruncated ||
    !guest.startsWith('/') ||
    /[\r\n\0]/.test(guest)
  ) {
    throw new Error('Text task path could not be resolved in WSL')
  }
  return guest
}
