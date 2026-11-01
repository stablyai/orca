import { createHash } from 'node:crypto'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isDirectInvocation } from '../../scripts/script-entry-detection.mjs'

const excluded = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  '.build',
  '.cache',
  'vendor',
  '.DS_Store',
  'Pods',
  '.gradle',
  '.expo'
])
const inputs = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'config',
  'src',
  'native',
  'resources',
  'mobile'
]

export async function sourceFingerprint(root) {
  const hash = createHash('sha256').update('orcad-source-v2\0')
  function appendSourceEntry(relative, kind, content) {
    const name = Buffer.from(relative)
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
    hash
      .update(kind)
      .update(`${name.length}:`)
      .update(name)
      .update(`${bytes.length}:`)
      .update(bytes)
  }
  async function visit(relative) {
    const path = join(root, relative)
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    )) {
      if (
        excluded.has(entry.name) ||
        entry.name.startsWith('.env') ||
        entry.name.endsWith('.log')
      ) {
        continue
      }
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        await visit(child)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        appendSourceEntry(
          child,
          entry.isSymbolicLink() ? 'L' : 'F',
          entry.isSymbolicLink()
            ? await readlink(join(root, child), { encoding: 'buffer' })
            : await readFile(join(root, child))
        )
      }
    }
  }
  for (const input of inputs) {
    if (input.includes('.')) {
      appendSourceEntry(input, 'F', await readFile(join(root, input)))
    } else {
      await visit(input)
    }
  }
  return hash.digest('hex')
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  console.log(await sourceFingerprint(process.cwd()))
}
