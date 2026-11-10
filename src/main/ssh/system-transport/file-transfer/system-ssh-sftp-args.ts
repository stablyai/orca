/** Translate SSH args explicitly: SFTP -p preserves mtime, -S names a binary, and -T is absent. Unknown flags must fall back rather than misroute. */

export class SftpArgTranslationError extends Error {
  constructor(flag: string) {
    super(`No sftp equivalent for system ssh argument ${JSON.stringify(flag)}`)
    this.name = 'SftpArgTranslationError'
  }
}

const PASSTHROUGH_VALUE_FLAGS = new Set(['-F', '-o', '-i', '-J'])

export function translateSshArgsToSftpArgs(sshArgs: readonly string[]): string[] {
  const sftpArgs: string[] = []
  let index = 0
  while (index < sshArgs.length) {
    const flag = sshArgs[index]!
    if (flag === '--') {
      // Everything after `--` is the destination, which both clients spell the same way.
      sftpArgs.push(...sshArgs.slice(index))
      return sftpArgs
    }
    const value = sshArgs[index + 1]
    if (PASSTHROUGH_VALUE_FLAGS.has(flag)) {
      if (value === undefined) {
        throw new SftpArgTranslationError(flag)
      }
      sftpArgs.push(flag, value)
      index += 2
      continue
    }
    if (flag === '-T') {
      // sftp never allocates a tty, so ssh's "no tty" request has nothing to translate to.
      index += 1
      continue
    }
    if (flag === '-p') {
      if (value === undefined) {
        throw new SftpArgTranslationError(flag)
      }
      sftpArgs.push('-o', `Port=${value}`)
      index += 2
      continue
    }
    if (flag === '-l') {
      // Translate unclaimed-alias login names too; rejection would cache an unnecessary fallback.
      if (value === undefined) {
        throw new SftpArgTranslationError(flag)
      }
      sftpArgs.push('-o', `User=${value}`)
      index += 2
      continue
    }
    if (flag === '-S') {
      // ssh's `-S none` is ControlPath=none; sftp's `-S` would run a binary called `none`.
      if (value !== 'none') {
        throw new SftpArgTranslationError(flag)
      }
      sftpArgs.push('-o', 'ControlPath=none')
      index += 2
      continue
    }
    throw new SftpArgTranslationError(flag)
  }
  return sftpArgs
}

/** Use keepalives to detect dead peers without imposing a wall-clock limit on healthy transfers. */
export function withSftpKeepalive(sftpArgs: readonly string[]): string[] {
  const hasOption = (name: string): boolean =>
    sftpArgs.some((arg, position) => sftpArgs[position - 1] === '-o' && arg.startsWith(`${name}=`))
  const keepalive: string[] = []
  if (!hasOption('ServerAliveInterval')) {
    keepalive.push('-o', 'ServerAliveInterval=15')
  }
  if (!hasOption('ServerAliveCountMax')) {
    keepalive.push('-o', 'ServerAliveCountMax=3')
  }
  return [...keepalive, ...sftpArgs]
}
