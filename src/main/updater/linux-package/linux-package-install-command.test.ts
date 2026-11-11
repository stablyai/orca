import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quotePosixShellDoubleQuotedApostrophe } from '../../../shared/shell/launch/shell-argument-quoting'

const { statSyncMock } = vi.hoisted(() => ({ statSyncMock: vi.fn() }))

vi.mock('node:fs', () => ({ statSync: statSyncMock }))

let executables: Map<string, { file: boolean; mode: number }>

function install(absolutePath: string, options?: { file?: boolean; mode?: number }): void {
  executables.set(absolutePath, { file: options?.file ?? true, mode: options?.mode ?? 0o755 })
}

async function loadCommandModule() {
  return import('./linux-package-install-command')
}

beforeEach(() => {
  vi.resetModules()
  executables = new Map()
  statSyncMock.mockReset().mockImplementation((candidate: string) => {
    const entry = executables.get(candidate)
    if (!entry) {
      const error = new Error(`ENOENT: ${candidate}`) as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    return { isFile: () => entry.file, mode: entry.mode }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('quotePosixShellDoubleQuotedApostrophe', () => {
  it('neutralizes expansion, command substitution, separators, and double quotes', () => {
    expect(quotePosixShellDoubleQuotedApostrophe('/tmp/$HOME.deb')).toBe("'/tmp/$HOME.deb'")
    expect(quotePosixShellDoubleQuotedApostrophe('/tmp/`id`.deb')).toBe("'/tmp/`id`.deb'")
    expect(quotePosixShellDoubleQuotedApostrophe('/tmp/a;rm -rf ~.deb')).toBe(
      "'/tmp/a;rm -rf ~.deb'"
    )
    expect(quotePosixShellDoubleQuotedApostrophe('/tmp/"quoted".deb')).toBe('\'/tmp/"quoted".deb\'')
  })

  it('closes and reopens the quote around a literal single quote', () => {
    expect(quotePosixShellDoubleQuotedApostrophe("/tmp/it's.deb")).toBe(`'/tmp/it'"'"'s.deb'`)
  })

  it('escapes every single quote in a value', () => {
    expect(quotePosixShellDoubleQuotedApostrophe("'; rm -rf /; '")).toBe(`''"'"'; rm -rf /; '"'"''`)
  })
})

describe('resolveTrustedExecutable', () => {
  it('ignores a user-writable absolute PATH decoy', async () => {
    install('/home/user/.local/bin/sudo')
    vi.stubEnv('PATH', '/home/user/.local/bin:/usr/bin')
    const { resolveTrustedExecutable } = await loadCommandModule()
    expect(resolveTrustedExecutable('sudo')).toBeNull()
    expect(statSyncMock).not.toHaveBeenCalledWith('/home/user/.local/bin/sudo')
  })

  it('rejects a non-executable file', async () => {
    install('/usr/bin/apt', { mode: 0o644 })
    const { resolveTrustedExecutable } = await loadCommandModule()
    expect(resolveTrustedExecutable('apt')).toBeNull()
  })

  it('rejects a directory of the same name', async () => {
    install('/usr/bin/apt', { file: false })
    const { resolveTrustedExecutable } = await loadCommandModule()
    expect(resolveTrustedExecutable('apt')).toBeNull()
  })
})

describe('buildLinuxPackageInstallCommand', () => {
  it('refuses a non-absolute package path before looking for anything', async () => {
    // Managers without -- support require absolute paths to prevent option injection.
    install('/usr/bin/sudo')
    install('/usr/bin/apt')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    for (const packagePath of ['orca.deb', './orca.deb', '--force-all', '-i']) {
      expect(buildLinuxPackageInstallCommand('deb', packagePath)).toEqual({
        ok: false,
        reason: 'invalid-package-path'
      })
    }
  })

  it('quotes a hostile package path', async () => {
    install('/usr/bin/sudo')
    install('/usr/bin/apt')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    expect(buildLinuxPackageInstallCommand('deb', "/tmp/a b'; id #.deb")).toEqual({
      ok: true,
      command: `/usr/bin/sudo /usr/bin/apt -o Binary::file::APT::Sandbox::User=root install -- '/tmp/a b'"'"'; id #.deb'`
    })
  })
})
