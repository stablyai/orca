import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTree } from '../../../../src/shared/windows-transient-lock-removal.ts'

const require = createRequire(import.meta.url)
const {
  assertNoWindowsExecutablesInRuntimeNodeModules
} = require('../../../packaged-windows-only-runtime-files.cjs')

async function withTempDir(prefix, run) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    await run(dir)
  } finally {
    await removeTree(dir)
  }
}

function peImage() {
  const image = Buffer.alloc(0x80)
  image.write('MZ', 0, 'latin1')
  image.writeUInt32LE(0x40, 0x3c)
  image.write('PE\0\0', 0x40, 'latin1')
  image.writeUInt16LE(0x14c, 0x44)
  return image
}

describe('Windows-only runtime files', () => {
  it('fails a non-Windows package that ships a Windows executable under any name', async () => {
    await withTempDir('orca-windows-exe-', async (resourcesDir) => {
      const nested = join(resourcesDir, 'node_modules', 'some-dep', 'bin')
      await mkdir(nested, { recursive: true })
      await writeFile(join(nested, 'helper'), peImage())
      // An MZ prefix alone is not a PE image; data files must not trip the check.
      await writeFile(join(nested, 'fake.exe'), Buffer.from('MZ not really'))

      for (const platform of ['darwin', 'linux']) {
        expect(() =>
          assertNoWindowsExecutablesInRuntimeNodeModules(resourcesDir, platform)
        ).toThrow(/: node_modules\/some-dep\/bin\/helper\. /)
      }
      expect(() =>
        assertNoWindowsExecutablesInRuntimeNodeModules(resourcesDir, 'win32')
      ).not.toThrow()
    })
  })
})
