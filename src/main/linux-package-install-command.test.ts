import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statSyncMock } = vi.hoisted(() => ({ statSyncMock: vi.fn() }))

vi.mock('node:fs', () => ({ statSync: statSyncMock }))

// Executables the fake filesystem exposes, keyed by absolute path.
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

describe('quoteForPosixShell', () => {
  it('wraps plain values in single quotes', async () => {
    const { quoteForPosixShell } = await loadCommandModule()
    expect(quoteForPosixShell('/tmp/orca.deb')).toBe("'/tmp/orca.deb'")
  })

  it('quotes spaces', async () => {
    const { quoteForPosixShell } = await loadCommandModule()
    expect(quoteForPosixShell('/tmp/Orca Setup.deb')).toBe("'/tmp/Orca Setup.deb'")
  })

  it('neutralizes expansion, command substitution, separators, and double quotes', async () => {
    const { quoteForPosixShell } = await loadCommandModule()
    expect(quoteForPosixShell('/tmp/$HOME.deb')).toBe("'/tmp/$HOME.deb'")
    expect(quoteForPosixShell('/tmp/`id`.deb')).toBe("'/tmp/`id`.deb'")
    expect(quoteForPosixShell('/tmp/a;rm -rf ~.deb')).toBe("'/tmp/a;rm -rf ~.deb'")
    expect(quoteForPosixShell('/tmp/"quoted".deb')).toBe('\'/tmp/"quoted".deb\'')
  })

  it('closes and reopens the quote around a literal single quote', async () => {
    const { quoteForPosixShell } = await loadCommandModule()
    expect(quoteForPosixShell("/tmp/it's.deb")).toBe(`'/tmp/it'"'"'s.deb'`)
  })

  it('escapes every single quote in a value', async () => {
    const { quoteForPosixShell } = await loadCommandModule()
    expect(quoteForPosixShell("'; rm -rf /; '")).toBe(`''"'"'; rm -rf /; '"'"''`)
  })

  it('quotes an empty value', async () => {
    const { quoteForPosixShell } = await loadCommandModule()
    expect(quoteForPosixShell('')).toBe("''")
  })
})

describe('resolveTrustedExecutable', () => {
  it('resolves from /usr/bin first', async () => {
    install('/usr/bin/sudo')
    install('/bin/sudo')
    const { resolveTrustedExecutable } = await loadCommandModule()
    expect(resolveTrustedExecutable('sudo')).toBe('/usr/bin/sudo')
  })

  it('falls through the remaining trusted directories', async () => {
    install('/sbin/dpkg')
    const { resolveTrustedExecutable } = await loadCommandModule()
    expect(resolveTrustedExecutable('dpkg')).toBe('/sbin/dpkg')
  })

  it('consults only the trusted directories', async () => {
    const { resolveTrustedExecutable } = await loadCommandModule()
    expect(resolveTrustedExecutable('sudo')).toBeNull()
    expect(statSyncMock.mock.calls.map((call) => call[0])).toEqual([
      '/usr/bin/sudo',
      '/bin/sudo',
      '/usr/sbin/sudo',
      '/sbin/sudo'
    ])
  })

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

  it('accepts a file executable only by group or other', async () => {
    install('/usr/bin/apt', { mode: 0o011 })
    const { resolveTrustedExecutable } = await loadCommandModule()
    expect(resolveTrustedExecutable('apt')).toBe('/usr/bin/apt')
  })

  it('rejects a directory of the same name', async () => {
    install('/usr/bin/apt', { file: false })
    const { resolveTrustedExecutable } = await loadCommandModule()
    expect(resolveTrustedExecutable('apt')).toBeNull()
  })
})

describe('buildLinuxPackageInstallCommand', () => {
  it('refuses a non-absolute package path before looking for anything', async () => {
    // Why: zypper/dnf/yum/rpm take no `--`, so a relative or dash-leading path would become an option.
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

  it('reports no-sudo when sudo is absent', async () => {
    install('/usr/bin/apt')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    expect(buildLinuxPackageInstallCommand('deb', '/tmp/orca.deb')).toEqual({
      ok: false,
      reason: 'no-sudo'
    })
  })

  it('reports no-package-manager when no manager is installed', async () => {
    install('/usr/bin/sudo')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    expect(buildLinuxPackageInstallCommand('deb', '/tmp/orca.deb')).toEqual({
      ok: false,
      reason: 'no-package-manager'
    })
  })

  it('does not fall back to an rpm manager for a deb package', async () => {
    install('/usr/bin/sudo')
    install('/usr/bin/dnf')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    expect(buildLinuxPackageInstallCommand('deb', '/tmp/orca.deb')).toEqual({
      ok: false,
      reason: 'no-package-manager'
    })
  })

  it('builds an apt command', async () => {
    install('/usr/bin/sudo')
    install('/usr/bin/apt')
    install('/usr/bin/dpkg')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    expect(buildLinuxPackageInstallCommand('deb', '/tmp/orca.deb')).toEqual({
      ok: true,
      command: "/usr/bin/sudo /usr/bin/apt install -- '/tmp/orca.deb'"
    })
  })

  it('falls back to dpkg', async () => {
    install('/usr/bin/sudo')
    install('/usr/bin/dpkg')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    expect(buildLinuxPackageInstallCommand('deb', '/tmp/orca.deb')).toEqual({
      ok: true,
      command: "/usr/bin/sudo /usr/bin/dpkg -i -- '/tmp/orca.deb'"
    })
  })

  it('builds a zypper command', async () => {
    install('/usr/bin/sudo')
    install('/usr/bin/zypper')
    install('/usr/bin/dnf')
    install('/usr/bin/yum')
    install('/usr/bin/rpm')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    expect(buildLinuxPackageInstallCommand('rpm', '/tmp/orca.rpm')).toEqual({
      ok: true,
      command:
        "/usr/bin/sudo /usr/bin/zypper --no-refresh install --allow-unsigned-rpm -f '/tmp/orca.rpm'"
    })
  })

  it('prefers dnf over yum and rpm', async () => {
    install('/usr/bin/sudo')
    install('/usr/bin/dnf')
    install('/usr/bin/yum')
    install('/usr/bin/rpm')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    expect(buildLinuxPackageInstallCommand('rpm', '/tmp/orca.rpm')).toEqual({
      ok: true,
      command: "/usr/bin/sudo /usr/bin/dnf install --nogpgcheck '/tmp/orca.rpm'"
    })
  })

  it('falls back to yum', async () => {
    install('/usr/bin/sudo')
    install('/usr/bin/yum')
    install('/usr/bin/rpm')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    expect(buildLinuxPackageInstallCommand('rpm', '/tmp/orca.rpm')).toEqual({
      ok: true,
      command: "/usr/bin/sudo /usr/bin/yum install --nogpgcheck '/tmp/orca.rpm'"
    })
  })

  it('falls back to rpm', async () => {
    install('/usr/bin/sudo')
    install('/sbin/rpm')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    expect(buildLinuxPackageInstallCommand('rpm', '/tmp/orca.rpm')).toEqual({
      ok: true,
      command: "/usr/bin/sudo /sbin/rpm -Uvh '/tmp/orca.rpm'"
    })
  })

  it('never adds an unattended-confirmation flag', async () => {
    install('/usr/bin/sudo')
    install('/usr/bin/apt')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    const result = buildLinuxPackageInstallCommand('deb', '/tmp/orca.deb')
    expect(result.ok).toBe(true)
    expect(result.ok ? result.command : '').not.toMatch(
      /(^|\s)(-y|--yes|--noconfirm|--assumeyes)(\s|$)/
    )
  })

  it('quotes a hostile package path', async () => {
    install('/usr/bin/sudo')
    install('/usr/bin/apt')
    const { buildLinuxPackageInstallCommand } = await loadCommandModule()
    expect(buildLinuxPackageInstallCommand('deb', "/tmp/a b'; id #.deb")).toEqual({
      ok: true,
      command: `/usr/bin/sudo /usr/bin/apt install -- '/tmp/a b'"'"'; id #.deb'`
    })
  })
})
