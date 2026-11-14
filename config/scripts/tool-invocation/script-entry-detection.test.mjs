import { runProcessSync } from '@orca/process-host'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('running a builder through a symlink', () => {
  // Canonicalize argv symlink: /tmp versus /private/tmp otherwise exits 0 without producing bundle.
  it('still recognises the entry module', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-script-entry-link-'))
    try {
      const moduleUrl = new URL('./script-entry-detection.mjs', import.meta.url).href
      const real = join(scratch, 'entry.mjs')
      await writeFile(
        real,
        `import { isDirectInvocation } from ${JSON.stringify(moduleUrl)}\n` +
          'process.stdout.write(String(isDirectInvocation(import.meta.url, process.argv[1])))\n',
        'utf8'
      )
      const link = join(scratch, 'entry-link.mjs')
      await symlink(real, link)
      const result = runProcessSync({
        program: process.execPath,
        args: [link],
        timeoutMs: 10_000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toBe('true')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
