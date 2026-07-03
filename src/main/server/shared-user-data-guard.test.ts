import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { warnIfSharingDesktopUserData } from './shared-user-data-guard'

describe('warnIfSharingDesktopUserData', () => {
  let dir: string
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-guard-'))
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('warns when the default dir already holds a desktop install (orca-data.json present)', () => {
    writeFileSync(join(dir, 'orca-data.json'), '{}')
    warnIfSharingDesktopUserData({ userDataPath: dir, explicitlyConfigured: false })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('ORCA_USER_DATA_PATH')
  })

  it('does NOT warn when the operator explicitly configured the dir', () => {
    writeFileSync(join(dir, 'orca-data.json'), '{}')
    warnIfSharingDesktopUserData({ userDataPath: dir, explicitlyConfigured: true })
    expect(warn).not.toHaveBeenCalled()
  })

  it('does NOT warn when the dir has no desktop data (fresh/isolated)', () => {
    warnIfSharingDesktopUserData({ userDataPath: dir, explicitlyConfigured: false })
    expect(warn).not.toHaveBeenCalled()
  })
})
