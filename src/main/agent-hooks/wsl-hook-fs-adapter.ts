// SFTP-shaped adapter over the WSL hook relay's fs bridge. Lets the
// unchanged SSH remote hook installers (`installRemoteManagedAgentHooks`)
// write into a WSL distro's home over the relay's already-open stdio channel
// — the WSL twin of the SSH flow's real SFTPWrapper. Only the primitives
// `installer-utils-remote.ts` touches are implemented.
import type { SFTPWrapper } from 'ssh2'

import type { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { wslCodexRuntimeHomeForGuestHome } from '../pty/codex-home-wsl-env'
import { WSL_HOOK_FS_METHODS, type WslFsResult } from '../../shared/wsl-hook-relay-contract'

/** Run the shared remote hook installers against a WSL guest over the relay's
 *  fs bridge. Codex is the one agent whose home Orca redirects for WSL
 *  sessions, so its hooks go to the managed runtime home. */
export async function installWslGuestHooks(options: {
  mux: SshChannelMultiplexer
  guestHome: string
  distro: string
  installHooks: typeof installRemoteManagedAgentHooks
  warn: (message: string) => void
}): Promise<void> {
  const { mux, guestHome, distro, installHooks, warn } = options
  const results = await installHooks(createWslHookSftpAdapter(mux), guestHome, {
    codexHomeDir: wslCodexRuntimeHomeForGuestHome(guestHome)
  })
  const failed = results.filter((r) => r.state === 'error').length
  if (failed > 0) {
    warn(
      `[agent-hooks] WSL hook install for '${distro}': ${failed}/${results.length} agents failed`
    )
  }
}

type SftpCallback<T = void> = (err: Error | null, value?: T) => void

// Why: installer-utils-remote classifies errors by ssh2's numeric SFTP status
// codes (ENOENT=2, already-exists=4). Map guest POSIX errno onto those so the
// shared classifiers keep working across transports.
const ERRNO_TO_SFTP_CODE: Record<string, number> = {
  ENOENT: 2,
  ENOTDIR: 2,
  EACCES: 3,
  EEXIST: 4
}

function toSftpError(failure: { errno?: string; message?: string }): Error {
  const err = new Error(failure.message ?? 'wsl fs bridge failure') as Error & { code?: number }
  err.code = ERRNO_TO_SFTP_CODE[failure.errno ?? ''] ?? 5
  return err
}

export function createWslHookSftpAdapter(mux: SshChannelMultiplexer): SFTPWrapper {
  const call = <Wire extends object, Value>(
    method: string,
    params: Record<string, unknown>,
    callback: SftpCallback<Value>,
    pick: (result: { ok: true } & Wire) => Value
  ): void => {
    mux
      .request(method, params)
      .then((raw) => {
        const result = raw as WslFsResult<Wire>
        if (!result || typeof result !== 'object' || result.ok !== true) {
          callback(toSftpError((result ?? {}) as { errno?: string; message?: string }))
          return
        }
        callback(null, pick(result))
      })
      .catch((err) => callback(err instanceof Error ? err : new Error(String(err))))
  }
  const callVoid = (
    method: string,
    params: Record<string, unknown>,
    callback: SftpCallback
  ): void => {
    call<Record<string, never>, undefined>(method, params, callback, () => undefined)
  }

  const adapter = {
    readFile(path: string, _encoding: unknown, callback: SftpCallback<string>): void {
      call<{ content: string }, string>(
        WSL_HOOK_FS_METHODS.readFile,
        { path },
        callback,
        (r) => r.content
      )
    },
    writeFile(
      path: string,
      content: string,
      options: { mode?: number },
      callback: SftpCallback
    ): void {
      callVoid(WSL_HOOK_FS_METHODS.writeFile, { path, content, mode: options?.mode }, callback)
    },
    stat(path: string, callback: SftpCallback<{ mode: number }>): void {
      call<{ mode: number }, { mode: number }>(
        WSL_HOOK_FS_METHODS.stat,
        { path },
        callback,
        (r) => ({
          mode: r.mode
        })
      )
    },
    // Why: POSIX rename overwrites atomically, which is exactly the OpenSSH
    // overwrite-rename semantics the installers prefer — so the extension is
    // "supported" here and plain rename shares the implementation.
    ext_openssh_rename(src: string, dst: string, callback: SftpCallback): void {
      callVoid(WSL_HOOK_FS_METHODS.rename, { src, dst }, callback)
    },
    rename(src: string, dst: string, callback: SftpCallback): void {
      callVoid(WSL_HOOK_FS_METHODS.rename, { src, dst }, callback)
    },
    unlink(path: string, callback: SftpCallback): void {
      callVoid(WSL_HOOK_FS_METHODS.unlink, { path }, callback)
    },
    chmod(path: string, mode: number, callback: SftpCallback): void {
      callVoid(WSL_HOOK_FS_METHODS.chmod, { path, mode }, callback)
    },
    readdir(path: string, callback: SftpCallback<{ filename: string }[]>): void {
      call<{ entries: { filename: string }[] }, { filename: string }[]>(
        WSL_HOOK_FS_METHODS.readdir,
        { path },
        callback,
        (r) => r.entries
      )
    },
    mkdir(path: string, callback: SftpCallback): void {
      callVoid(WSL_HOOK_FS_METHODS.mkdir, { path }, callback)
    }
  }

  return adapter as unknown as SFTPWrapper
}
