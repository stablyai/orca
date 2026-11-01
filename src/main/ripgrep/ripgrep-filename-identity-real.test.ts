import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnBundledRipgrep } from './bundled-ripgrep-spawn'
import { buildRgArgsForQuickOpen, normalizeQuickOpenRgLine } from '../../shared/quick-open-filter'
import { buildRgArgs, createAccumulator, ingestRgJsonLine } from '../../shared/text-search'
import { joinWorktreeRelativePath } from '../runtime/runtime-relative-paths'

async function capture(root: string, args: string[]): Promise<string> {
  const child = spawnBundledRipgrep(args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
  })
  child.stderr?.resume()
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`rg exit ${code}`))))
  })
  return output
}

describe.skipIf(process.platform === 'win32')('real ripgrep POSIX filename identities', () => {
  it('lists, searches, and opens literal-backslash and nested names independently', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'orca-rg-identity-'))
    const root = join(parent, 'repo\\root')
    try {
      await mkdir(join(root, 'a'), { recursive: true })
      await writeFile(join(root, 'a\\b.txt'), 'needle literal')
      await writeFile(join(root, 'a/b.txt'), 'needle nested')
      const args = buildRgArgsForQuickOpen({
        searchRoot: '.',
        excludePathPrefixes: [],
        forceSlashSeparator: false
      })
      const listing = await capture(root, args.primary)
      const names = listing
        .split('\0')
        .filter(Boolean)
        .map((line) => normalizeQuickOpenRgLine(line, { kind: 'cwd-relative' }))
      expect(names.sort()).toEqual(['a/b.txt', 'a\\b.txt'].sort())
      for (const name of names) {
        expect(name).not.toBeNull()
        if (name === null) {
          throw new Error('invalid name')
        }
        expect(await readFile(joinWorktreeRelativePath(root, name), 'utf8')).toBe(
          name === 'a\\b.txt' ? 'needle literal' : 'needle nested'
        )
      }
      const acc = createAccumulator()
      for (const line of (await capture(root, buildRgArgs('needle', '.', {}))).split('\n')) {
        ingestRgJsonLine(line, root, acc, 10)
      }
      expect([...acc.fileMap.values()].map((file) => file.relativePath).sort()).toEqual(names)
      expect(acc.truncated).toBe(false)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
