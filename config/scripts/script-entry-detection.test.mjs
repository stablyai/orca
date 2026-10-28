import { runProcessSync } from '@orca/process-host'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isDirectInvocation } from './script-entry-detection.mjs'

describe('isDirectInvocation', () => {
  const thisFile = import.meta.filename

  it('matches the path this module was loaded from', () => {
    expect(isDirectInvocation(import.meta.url, thisFile)).toBe(true)
  })

  it('does not match a different script', () => {
    expect(isDirectInvocation(import.meta.url, join(thisFile, '..', 'other.mjs'))).toBe(false)
  })

  it('tolerates an absent argv[1]', () => {
    expect(isDirectInvocation(import.meta.url, undefined)).toBe(false)
    expect(isDirectInvocation(import.meta.url, '')).toBe(false)
  })

  it('compares the literal entry path when realpath cannot resolve it', () => {
    const entry = join(tmpdir(), 'unresolved entry # %.mjs')
    const realpath = () => {
      throw new Error('unresolvable fixture path')
    }
    expect(isDirectInvocation(pathToFileURL(entry).href, entry, { realpath })).toBe(true)
    expect(isDirectInvocation(import.meta.url, entry, { realpath })).toBe(false)
  })

  // Inject converter to exercise Windows URLs from POSIX CI.
  const toWin32FileUrl = (windowsPath) => new URL(`file:///${windowsPath.replaceAll('\\', '/')}`)

  it('matches a Windows entry path, which the file:// template form never does', () => {
    const scriptPath = 'C:\\orca\\config\\scripts\\build-mobile-web-app-bundle.mjs'
    const moduleUrl = 'file:///C:/orca/config/scripts/build-mobile-web-app-bundle.mjs'
    const keepAsIs = (path) => path
    expect(
      isDirectInvocation(moduleUrl, scriptPath, {
        toFileUrl: toWin32FileUrl,
        realpath: keepAsIs
      })
    ).toBe(true)
  })
})

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
