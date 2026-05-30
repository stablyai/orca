import { ipcMain } from 'electron'
import type { SshConnectionManager } from '../ssh/ssh-connection'

export type RemoteDirEntry = {
  name: string
  isDirectory: boolean
}

// Why: the relay's fs.readDir enforces workspace root ACLs, which aren't
// registered until a repo is added. This handler uses a raw SSH exec channel
// to list directories, allowing the user to browse the remote filesystem
// during the "add remote project" flow before any roots exist.
export function registerSshBrowseHandler(
  getConnectionManager: () => SshConnectionManager | null
): void {
  ipcMain.removeHandler('ssh:browseDir')

  ipcMain.handle(
    'ssh:browseDir',
    async (
      _event,
      args: { targetId: string; dirPath: string }
    ): Promise<{ entries: RemoteDirEntry[]; resolvedPath: string }> => {
      const mgr = getConnectionManager()
      if (!mgr) {
        throw new Error('SSH connection manager not initialized')
      }
      const conn = mgr.getConnection(args.targetId)
      if (!conn) {
        throw new Error(`SSH connection "${args.targetId}" not found`)
      }

      // Why: using one line per entry preserves filenames containing spaces.
      // `command ls` bypasses user aliases/functions like `ls='eza ...'`.
      // The -1 flag outputs one entry per line. The -p flag appends / to directories.
      // We resolve ~ and get the absolute path via `cd <path> && pwd`.
      // `cd` and `ls` are chained with `&&` so a failing `ls` (e.g. permission
      // denied after a readable `cd ... && pwd`) propagates as a non-zero exit
      // code rather than being indistinguishable from an empty directory.
      const command = `cd ${shellEscape(args.dirPath)} && pwd && command ls -1Ap`
      const channel = await conn.exec(command)

      return new Promise((resolve, reject) => {
        let stdout = ''
        let stderr = ''
        let exitCode: number | null = null
        let settled = false

        const cleanup = (): void => {
          channel.off('data', onStdoutData)
          channel.stderr.off('data', onStderrData)
          channel.off('exit', onExit)
          channel.off('close', onClose)
          channel.off('error', onError)
          channel.stderr.off('error', onError)
        }
        const rejectOnce = (error: Error): void => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          reject(error)
        }
        const resolveOnce = (result: { entries: RemoteDirEntry[]; resolvedPath: string }): void => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          resolve(result)
        }

        const onStdoutData = (data: Buffer): void => {
          stdout += data.toString()
        }
        const onStderrData = (data: Buffer): void => {
          stderr += data.toString()
        }
        // `exit` fires before `close`; capture the code so we can distinguish
        // a failed `ls` that still produced `pwd` output from an empty listing.
        const onExit = (code: number | null): void => {
          exitCode = code
        }
        const onError = (error: Error): void => {
          rejectOnce(error)
        }
        const onClose = (): void => {
          // A null exitCode means the server closed the channel without
          // sending an exit-status message (or signalled termination). We
          // can't assume success — falling back to "empty stdout = empty
          // directory" is exactly the bug the exit-code branch was added to
          // fix. Treat any non-zero OR null exit as a failure when stderr
          // has content, and otherwise require stdout to contain at least
          // the resolved `pwd` line before accepting the result.
          if (exitCode !== 0) {
            const msg =
              stderr.trim() ||
              (exitCode === null
                ? 'Remote listing failed (channel closed without exit status)'
                : `Remote listing failed (exit ${exitCode})`)
            rejectOnce(new Error(msg))
            return
          }
          if (stderr.trim() && !stdout.trim()) {
            rejectOnce(new Error(stderr.trim()))
            return
          }

          const lines = stdout.trim().split('\n')
          if (lines.length === 0) {
            rejectOnce(new Error('Empty response from remote'))
            return
          }

          const resolvedPath = lines[0]
          const entries: RemoteDirEntry[] = []

          for (let i = 1; i < lines.length; i++) {
            const line = lines[i]
            if (!line || line === './' || line === '../') {
              continue
            }
            if (line.endsWith('/')) {
              entries.push({ name: line.slice(0, -1), isDirectory: true })
            } else {
              entries.push({ name: line, isDirectory: false })
            }
          }

          // Sort: directories first, then alphabetical
          entries.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) {
              return a.isDirectory ? -1 : 1
            }
            return a.name.localeCompare(b.name)
          })

          resolveOnce({ entries, resolvedPath })
        }

        channel.on('data', onStdoutData)
        channel.stderr.on('data', onStderrData)
        channel.on('exit', onExit)
        channel.on('close', onClose)
        // Why: SSH exec streams emit `error` on transport loss; without a
        // scoped listener, a disappearing remote can become process-fatal.
        channel.on('error', onError)
        channel.stderr.on('error', onError)
      })
    }
  )
}

// Why: prevent shell injection in the directory path. Single-quote wrapping
// with escaped internal single quotes is the safest approach for sh/bash.
// Tilde must be expanded by the shell, so paths starting with ~ use $HOME
// substitution instead of literal quoting (single quotes suppress expansion).
function shellEscape(s: string): string {
  if (s === '~') {
    return '"$HOME"'
  }
  if (s.startsWith('~/')) {
    return `"$HOME"/${shellEscapeRaw(s.slice(2))}`
  }
  return shellEscapeRaw(s)
}

function shellEscapeRaw(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}
