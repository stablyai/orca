import type { RemoteInstallTransport } from './remote-install-transport'
import type { InstallLockOwnerFile } from './remote-install-lock-commands'
import {
  INSTALL_LOCK_HOLDER_HELD,
  INSTALL_LOCK_HOLDER_MARK,
  INSTALL_LOCK_HOLDER_READY,
  installLockHolderCommand
} from './remote-install-lock-holder-commands'

const HOLDER_ANSWER_TIMEOUT_MS = 15_000

/** A guest process keeping the install lock flock-backed; `lost` settles if it exits before release. */
export type InstallLockHolder = { lost: Promise<void>; release(): void }

export class InstallLockHolderUnconfirmedError extends Error {
  constructor() {
    super('The install lock holder did not confirm it marked the lock; giving up this install.')
    this.name = 'InstallLockHolderUnconfirmedError'
  }
}

/** Null when the host cannot back the lock (no flock, no exclusive locks, lock not ours): the
 * lock stays unmarked, so contenders keep today's rules. Throws only when the lock may be
 * marked but this client cannot keep its holder alive. */
export async function startInstallLockHolder(
  conn: RemoteInstallTransport,
  lockDir: string,
  owner: InstallLockOwnerFile,
  signal?: AbortSignal
): Promise<InstallLockHolder | null> {
  signal?.throwIfAborted()
  const channel = await conn.exec(installLockHolderCommand(lockDir, owner), { signal })
  let stdout = ''
  let released = false
  let closed = false
  let notify: () => void = () => {}
  const closedOrLine = (): void => notify()
  const onData = (chunk: Buffer | string): void => {
    stdout += chunk.toString()
    closedOrLine()
  }
  const onClose = (): void => {
    closed = true
    closedOrLine()
  }
  channel.on('data', onData)
  channel.on('close', onClose)
  channel.on('error', onClose)
  channel.stderr.on('data', () => {})
  const waitFor = (line: string): Promise<boolean> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (stdout.split(/\r?\n/u).includes(line)) {
          finish(true)
        } else if (closed || signal?.aborted) {
          finish(false)
        }
      }
      const timer = setTimeout(() => finish(false), HOLDER_ANSWER_TIMEOUT_MS)
      const finish = (answered: boolean): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', check)
        notify = () => {}
        resolve(answered)
      }
      notify = check
      signal?.addEventListener('abort', check, { once: true })
      check()
    })
  const close = (): void => {
    channel.off('data', onData)
    channel.close()
  }

  // Closing stdin before `mark` means the holder exits on EOF without ever marking the lock.
  if (!(await waitFor(INSTALL_LOCK_HOLDER_READY))) {
    close()
    signal?.throwIfAborted()
    return null
  }
  channel.write(`${INSTALL_LOCK_HOLDER_MARK}\n`)
  if (!(await waitFor(INSTALL_LOCK_HOLDER_HELD))) {
    close()
    signal?.throwIfAborted()
    throw new InstallLockHolderUnconfirmedError()
  }
  channel.off('data', onData)
  channel.resume()
  const lost = new Promise<void>((resolve) => {
    const settle = (): void => {
      if (!released) {
        resolve()
      }
    }
    if (closed) {
      settle()
    }
    channel.once('close', settle)
    channel.once('error', settle)
  })
  return {
    lost,
    release: () => {
      released = true
      channel.close()
    }
  }
}
