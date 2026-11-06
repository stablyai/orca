import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { collectNativeBinaries } = require('./verify-linux-glibc-floor.cjs')

// 0x7f 'E' 'L' 'F' + class/data/version padding — enough for the magic check.
const ELF_HEADER = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])

describe('collectNativeBinaries', () => {
  it('collects only ELF .node/.so/executable files, skipping non-ELF and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-glibc-collect-'))
    try {
      await mkdir(join(root, 'nested'), { recursive: true })
      await writeFile(join(root, 'addon.node'), ELF_HEADER)
      await writeFile(join(root, 'nested', 'lib.so'), ELF_HEADER)
      await writeFile(join(root, 'nested', 'lib.so.1'), ELF_HEADER)
      await writeFile(join(root, 'orca-ide'), ELF_HEADER) // extensionless executable
      await writeFile(join(root, 'script.js'), ELF_HEADER) // has extension, not native
      await writeFile(join(root, 'text.node'), 'not an elf file') // native name, non-ELF
      await writeFile(join(root, 'notes.md'), ELF_HEADER)
      try {
        await symlink(join(root, 'addon.node'), join(root, 'alias.node'))
      } catch {
        // Symlink creation can be restricted; the rest of the assertions still hold.
      }

      const found = collectNativeBinaries(root).map((p) => p.slice(root.length + 1))
      expect(found).toContain('addon.node')
      expect(found).toContain(join('nested', 'lib.so'))
      expect(found).toContain(join('nested', 'lib.so.1'))
      expect(found).toContain('orca-ide')
      expect(found).not.toContain('script.js')
      expect(found).not.toContain('text.node')
      expect(found).not.toContain('notes.md')
      expect(found).not.toContain('alias.node')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
