import { spawn } from 'child_process'
import { relative, sep } from 'path'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'

// Why: We use --hidden to surface dotfiles users commonly edit (e.g. .env,
// .github workflows, .eslintrc) but must still exclude non-editable hidden
// directories that would clutter quick-open results. A blocklist is used
// instead of an allowlist so that novel dotfiles (e.g. .dockerignore) are
// discoverable by default. Keep this list limited to tool-generated dirs
// that are never hand-edited.
const HIDDEN_DIR_BLOCKLIST = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.cache',
  '.stably',
  '.vscode',
  '.idea',
  '.yarn',
  '.pnpm-store',
  '.terraform',
  '.docker',
  '.husky'
])

// Why: Avoids allocating a segments array per path. Walks the string to
// extract each '/'-delimited segment and checks it against the blocklist.
function shouldIncludeQuickOpenPath(path: string): boolean {
  let start = 0
  const len = path.length
  while (start < len) {
    let end = path.indexOf('/', start)
    if (end === -1) {
      end = len
    }
    const segment = path.substring(start, end)
    if (segment === 'node_modules' || HIDDEN_DIR_BLOCKLIST.has(segment)) {
      return false
    }
    start = end + 1
  }
  return true
}

export async function listQuickOpenFiles(rootPath: string, store: Store): Promise<string[]> {
  const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)

  // Why: We try fast string slicing first (O(1) per file), but fall back to
  // path.relative() if the rg output doesn't start with the expected prefix.
  // This handles edge cases where symlinks, bind mounts, Windows junctions,
  // or custom ripgreprc --path-separator settings cause a mismatch.
  const normalizedPrefix = `${authorizedRootPath.replace(/[\\/]+/g, '/').replace(/\/$/, '')}/`
  const prefixLen = normalizedPrefix.length

  const files = new Set<string>()

  const runRg = (args: string[]): Promise<void> => {
    return new Promise((resolve) => {
      let buf = ''
      let done = false
      const finish = (): void => {
        if (done) {
          return
        }
        done = true
        clearTimeout(timer)
        resolve()
      }

      const processLine = (line: string): void => {
        if (line.charCodeAt(line.length - 1) === 13 /* \r */) {
          line = line.substring(0, line.length - 1)
        }
        if (!line) {
          return
        }
        // Why: Normalize separators to '/' so the prefix check works on all
        // platforms (Windows rg uses '\', macOS/Linux use '/').
        const normalized = line.replace(/\\/g, '/')
        let relPath: string
        if (normalized.startsWith(normalizedPrefix)) {
          relPath = normalized.substring(prefixLen)
        } else {
          // Fallback: symlink resolution or path-separator mismatch between
          // Node and rg — use path.relative() which handles all edge cases.
          relPath = relative(authorizedRootPath, line).replace(/\\/g, '/')
          if (relPath.startsWith('..') || relPath.startsWith('/')) {
            // Safety: path escapes the root — skip it entirely
            return
          }
        }
        if (shouldIncludeQuickOpenPath(relPath)) {
          files.add(relPath)
        }
      }

      const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.setEncoding('utf-8')
      child.stdout.on('data', (chunk: string) => {
        buf += chunk
        let start = 0
        let newlineIdx = buf.indexOf('\n', start)
        while (newlineIdx !== -1) {
          processLine(buf.substring(start, newlineIdx))
          start = newlineIdx + 1
          newlineIdx = buf.indexOf('\n', start)
        }
        // Keep the incomplete trailing segment for the next chunk
        buf = start < buf.length ? buf.substring(start) : ''
      })
      child.stderr.on('data', () => {
        /* drain */
      })
      child.once('error', () => {
        finish()
      })
      child.once('close', () => {
        if (buf) {
          processLine(buf)
        }
        finish()
      })
      const timer = setTimeout(() => child.kill(), 10000)
    })
  }

  // Why: --hidden is needed so users can quick-open dotfiles they commonly
  // edit (.env, .github/*, .eslintrc, etc.). Without it, rg skips all
  // dot-prefixed paths. The HIDDEN_DIR_BLOCKLIST in shouldIncludeQuickOpenPath
  // filters out tool-generated dirs that would clutter results.
  //
  // The second rg call adds --no-ignore-vcs to also surface .env* files that
  // are typically in .gitignore. These are included because users frequently
  // need to view/edit .env files from quick-open, and excluding them would
  // force users to navigate manually. The files are read-only in search
  // results — they are not committed or exposed outside the local editor.

  // Why: On Windows, rg outputs '\'-separated paths. Forcing '/' via
  // --path-separator avoids per-line backslash replacement in processLine.
  const rgSepArgs = sep === '\\' ? ['--path-separator', '/'] : []

  await Promise.all([
    runRg([
      '--files',
      '--hidden',
      ...rgSepArgs,
      '--glob',
      '!**/node_modules',
      '--glob',
      '!**/.git',
      authorizedRootPath
    ]),
    runRg([
      '--files',
      '--hidden',
      '--no-ignore-vcs',
      ...rgSepArgs,
      '--glob',
      '**/.env*',
      '--glob',
      '!**/node_modules',
      '--glob',
      '!**/.git',
      authorizedRootPath
    ])
  ])

  return Array.from(files)
}
