import type { RemoteInstallTransport } from './remote-install-transport'
import type { InstallLockOwnerFile } from './remote-install-lock-commands'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import {
  INSTALL_LOCK_HOLDER_HELD,
  INSTALL_LOCK_HOLDER_MARK,
  INSTALL_LOCK_HOLDER_READY,
  installLockHolderCommand,
  installLockHolderUnmarkCommand
} from './remote-install-lock-holder-commands'

const HOLDER_ANSWER_TIMEOUT_MS = 15_000
const UNMARK_ATTEMPTS = 2

/** The distro never confirmed an abandoned holder's mark was cleared, so installing is unsafe. */
export class InstallLockUnmarkError extends Error {
  constructor(cause: unknown) {
    super(
      'Orca couldn’t set up its install in this distro because the distro stopped answering, so it stopped. Try connecting again.',
      { cause }
    )
    this.name = 'InstallLockUnmarkError'
  }
}

/** A guest process keeping the install lock flock-backed; `lost` settles if it exits before release. */
export type InstallLockHolder = { lost: Promise<void>; release(): void }

/** `fenceable`: the holder file exists in a lock this owner holds, so commands can still be fenced. */
export type InstallLockHolderStart =
  | { holder: InstallLockHolder }
  | { holder: null; fenceable: boolean }

/** Without a confirmed holder the lock is left unmarked, so contenders keep the age rules. */
export async function startInstallLockHolder(
  conn: RemoteInstallTransport,
  lockDir: string,
  owner: InstallLockOwnerFile,
  signal?: AbortSignal
): Promise<InstallLockHolderStart> {
  signal?.throwIfAborted()
  let channel: Awaited<ReturnType<RemoteInstallTransport['exec']>>
  try {
    channel = await conn.exec(installLockHolderCommand(lockDir, owner), { signal })
  } catch (error) {
    signal?.throwIfAborted()
    console.warn('[ssh] Install lock holder did not start; keeping an unbacked lock', error)
    return { holder: null, fenceable: false }
  }
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
    return { holder: null, fenceable: false }
  }
  channel.write(`${INSTALL_LOCK_HOLDER_MARK}\n`)
  if (!(await waitFor(INSTALL_LOCK_HOLDER_HELD))) {
    // It may have marked the lock before going quiet: let it exit, then clear any mark.
    close()
    signal?.throwIfAborted()
    console.warn('[ssh] Install lock holder did not confirm; keeping an unbacked lock')
    let unmarkError: unknown
    for (let attempt = 0; attempt < UNMARK_ATTEMPTS; attempt++) {
      try {
        await execCommand(conn, installLockHolderUnmarkCommand(lockDir, owner), {
          wrapCommand: true,
          signal
        })
        return { holder: null, fenceable: true }
      } catch (error) {
        if (isUnconfirmedSshCommandTermination(error)) {
          throw error
        }
        signal?.throwIfAborted()
        unmarkError = error
      }
    }
    // A mark may outlive its holder and invite a takeover mid-install: stop, and let cleanup remove the lock.
    throw new InstallLockUnmarkError(unmarkError)
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
    holder: {
      lost,
      release: () => {
        if (!released) {
          released = true
          channel.close()
        }
      }
    }
  }
}
