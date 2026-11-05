import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertNoCarriageReturnsInSource } from './mobile-web-source-line-endings.mjs'

describe('assertNoCarriageReturnsInSource', () => {
  it('rejects a CRLF source file, because CRLF changes every asset hash and the buildId', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-eol-'))
    try {
      await writeFile(join(scratch, 'route.tsx'), 'const a = 1\r\nconst b = 2\r\n', 'utf8')
      await expect(assertNoCarriageReturnsInSource(scratch)).rejects.toThrow(
        /CRLF in mobile web source/
      )
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
