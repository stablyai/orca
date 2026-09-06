/**
 * Rewrites `buildSshArgs` output for the sftp(1) client.
 *
 * Three flags ssh and sftp share spell different things: sftp's `-p` is "preserve mtime", its `-S`
 * names the ssh binary to run, and it has no `-T` at all. Passing ssh's list through unchanged
 * would silently connect to the wrong port and try to exec a program called `none`.
 *
 * Anything this table does not recognize throws. A flag added to `buildSshArgs` later must degrade
 * to the non-sftp transfer path, never reach sftp carrying a different meaning.
 */

/** `buildSshArgs` emitted a flag with no sftp equivalent; the caller should use another transport. */
export class SftpArgTranslationError extends Error {
  constructor(flag: string) {
    super(`No sftp equivalent for system ssh argument ${JSON.stringify(flag)}`)
    this.name = 'SftpArgTranslationError'
  }
}

/** Flags whose spelling and meaning are identical in both clients. */
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
      // sftp has no `-l`; the login name is an option there. `buildSshArgs` emits this for an
      // unclaimed config alias, so throwing would route those hosts down the defective path and
      // then cache the refusal against them for half an hour.
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

/**
 * A transfer that stalls mid-stream has no per-write bound to catch it, so ask OpenSSH to notice a
 * dead peer itself. Only added when the caller has not already stated a keepalive policy.
 */
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
