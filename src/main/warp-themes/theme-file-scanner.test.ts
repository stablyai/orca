import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { scanWarpThemeDirectory } from './theme-file-scanner'

it('reuses one collator per directory while preserving capped scan order', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'orca-theme-order-'))
  const names = ['éclair', 'item2', 'item10', 'Ångström', 'zebra', 'İstanbul']
  try {
    await Promise.all(names.map((name) => writeFile(path.join(directory, `${name}.yaml`), '')))
    await mkdir(path.join(directory, 'nested'))
    await writeFile(path.join(directory, 'nested', 'theme.yaml'), '')
    const expected = (await readdir(directory))
      // oxlint-disable-next-line sort-comparator-performance/no-repeated-collator -- Preserve the old comparator as the parity oracle.
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map((name) => (name === 'nested' ? path.join(name, 'theme.yaml') : name))
    const NativeCollator = Intl.Collator
    const construct = vi.spyOn(Intl, 'Collator').mockImplementation(function (locales, options) {
      return new NativeCollator(locales, options)
    })
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
    try {
      const result = await scanWarpThemeDirectory(directory, undefined, { themeFileLimit: 6 })
      expect(result.files.map((file) => file.label)).toEqual(expected.slice(0, 6))
      expect(result.themeFileLimitHit).toBe(true)
      // One directory needs collation; the single-entry nested folder needs none.
      expect(construct).toHaveBeenCalledExactlyOnceWith(undefined, { sensitivity: 'base' })
      expect(localeCompare).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
