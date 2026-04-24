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

      // Why: using printf with a delimiter instead of ls avoids issues with
      // filenames containing spaces or special characters. The -1 flag outputs
      // one entry per line. The -p flag appends / to directories.
      // We resolve ~ and get the absolute path via `cd <path> && pwd`.
      const command = `cd ${shellEscape(args.dirPath)} && pwd && ls -1ap`
      const channel = await conn.exec(command)

      return new Promise((resolve, reject) => {
        let stdout = ''
        let stderr = ''

        channel.on('data', (data: Buffer) => {
          stdout += data.toString()
        })
        channel.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })
        channel.on('close', () => {
          if (stderr.trim() && !stdout.trim()) {
            reject(new Error(stderr.trim()))
            return
          }

          const lines = stdout.trim().split('\n')
          if (lines.length === 0) {
            reject(new Error('Empty response from remote'))
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

          resolve({ entries, resolvedPath })
        })
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
