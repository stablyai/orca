import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import path from 'node:path'

const excludedDirectories = new Set(['node_modules', 'build', 'Pods', '.git', '.expo', '.gradle'])
const shellSourceRoots = [
  'mobile/app',
  'mobile/src',
  'mobile/packages',
  'src/shared',
  'src/mobile-web/src'
]

export async function fingerprintHostedIosOtaShell({ worktree, nativeAppPath }) {
  const source = await fingerprintRoots(
    shellSourceRoots.map((name) => [name, path.join(worktree, name)])
  )
  const native = await fingerprintRoots([['Orca.app', nativeAppPath]])
  return { source, native, sourceRoots: shellSourceRoots }
}

async function fingerprintRoots(roots) {
  const hash = createHash('sha256')
  let files = 0
  async function visit(label, filename) {
    const info = await lstat(filename)
    if (info.isDirectory()) {
      const entries = (await readdir(filename)).sort()
      for (const entry of entries) {
        if (!excludedDirectories.has(entry)) {
          await visit(`${label}/${entry}`, path.join(filename, entry))
        }
      }
      return
    }
    if (++files > 30_000) {
      throw new Error('OTA shell fingerprint exceeded file ceiling')
    }
    hash.update(`${label}\0`)
    if (info.isSymbolicLink()) {
      hash.update(`link:${await readlink(filename)}\0`)
    } else if (info.isFile()) {
      const contents = createHash('sha256')
      for await (const chunk of createReadStream(filename)) {
        contents.update(chunk)
      }
      hash.update(`${contents.digest('hex')}\0`)
    } else {
      throw new Error('Unexpected shell artifact entry')
    }
  }
  for (const [label, filename] of roots) {
    await visit(label, filename)
  }
  return { sha256: hash.digest('hex'), files }
}
