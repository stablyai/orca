import { spawn } from 'child_process'
import { relative } from 'path'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'

function normalizeRelativePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
}

function shouldIncludeQuickOpenPath(path: string): boolean {
  const normalizedPath = normalizeRelativePath(path)
  const segments = normalizedPath.split('/')
  return segments.every((segment, index) => {
    if (segment === 'node_modules') {
      return false
    }
    if (segment.startsWith('.') && !(index === 0 && segment === '.github')) {
      return false
    }
    return true
  })
}

export async function listQuickOpenFiles(rootPath: string, store: Store): Promise<string[]> {
  const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)
  return new Promise((resolve) => {
    const files: string[] = []
    let buf = ''
    let done = false
    const finish = (): void => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      resolve(files)
    }
    const child = spawn(
      'rg',
      [
        '--files',
        // Why: --hidden + positive re-inclusion globs (e.g. '.github') made
        // ripgrep treat them as a whitelist, filtering out every non-dotfile.
        // Without --hidden, rg skips dot-dirs by default and respects
        // .gitignore, so normal files like CLAUDE.md are returned correctly.
        '--glob',
        '!**/node_modules',
        authorizedRootPath
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (let line of lines) {
        line = line.replace(/\r$/, '')
        if (!line) {
          continue
        }
        const relPath = normalizeRelativePath(relative(authorizedRootPath, line))
        if (shouldIncludeQuickOpenPath(relPath)) {
          files.push(relPath)
        }
      }
    })
    child.stderr.on('data', () => {
      /* drain */
    })
    child.once('error', () => {
      finish()
    })
    child.once('close', () => {
      if (buf) {
        // [Fix]: Strip trailing \r on Windows for the final buffered chunk
        buf = buf.replace(/\r$/, '')
        const relPath = normalizeRelativePath(relative(authorizedRootPath, buf))
        if (shouldIncludeQuickOpenPath(relPath)) {
          files.push(relPath)
        }
      }
      finish()
    })
    const timer = setTimeout(() => child.kill(), 10000)
  })
}
