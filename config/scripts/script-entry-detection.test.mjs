import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  // Why an injected converter: a win32 path cannot be exercised through node:url's pathToFileURL
  // on a posix runner, and CI is ubuntu.
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
    // The regression this guards: `file://${argv[1]}` yields file://C:\orca\... on Windows,
    // so the builder exited 0 having written nothing and packaging failed downstream.
    expect(`file://${scriptPath}`).not.toBe(moduleUrl)
  })

  it('is not written with the file:// template form', async () => {
    const source = await readFile(new URL('./script-entry-detection.mjs', import.meta.url), 'utf8')
    expect(source).not.toMatch(/file:\/\/\$\{process\.argv\[1\]\}/)
    expect(source).toContain('pathToFileURL')
  })
})

describe('running a builder through a symlink', () => {
  // Node resolves symlinks in import.meta.url but not in argv[1]. Before the guard realpath'd the
  // entry path, `node /tmp/<link>` compared /tmp against /private/tmp and the builder exited 0
  // having written nothing — a green packaging job with no bundle in it.
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
      expect(execFileSync(process.execPath, [link], { encoding: 'utf8' })).toBe('true')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
