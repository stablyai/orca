import { beforeEach, describe, expect, it, vi } from 'vitest'

const { buildLinuxPackageInstallCommandMock, resolveTrustedExecutableMock } = vi.hoisted(() => ({
  buildLinuxPackageInstallCommandMock: vi.fn(),
  resolveTrustedExecutableMock: vi.fn()
}))

vi.mock('./linux-package-install-command', () => ({
  buildLinuxPackageInstallCommand: buildLinuxPackageInstallCommandMock,
  resolveTrustedExecutable: resolveTrustedExecutableMock,
  quoteForPosixShell: (value: string) => `'${value.split("'").join(`'"'"'`)}'`
}))

const { buildServeManualUpdateSteps, getServeUpgradeDocUrl, SERVE_UPGRADE_DOC_URL } =
  await import('./serve-manual-update-steps')

const RELEASE_URL = 'https://github.com/stablyai/orca/releases/tag/v1.4.200'

function stepsFor(overrides: {
  method: 'deb' | 'rpm' | 'appimage' | 'extracted-appimage' | 'externally-managed' | 'unknown'
  appImagePath?: string | null
  latestVersion?: string
  platform?: NodeJS.Platform
}): string[] {
  return buildServeManualUpdateSteps({
    method: overrides.method,
    latestVersion: overrides.latestVersion ?? '1.4.200',
    releaseUrl: RELEASE_URL,
    appImagePath: overrides.appImagePath ?? null,
    platform: overrides.platform ?? 'linux'
  })
}

describe('buildServeManualUpdateSteps', () => {
  beforeEach(() => {
    buildLinuxPackageInstallCommandMock.mockReset().mockImplementation((_type, packagePath) => ({
      ok: true,
      command: `/usr/bin/sudo /usr/bin/apt install -- '${packagePath}'`
    }))
    resolveTrustedExecutableMock
      .mockReset()
      .mockImplementation((name: string) => `/usr/bin/${name}`)
  })

  it('names the exact package-manager command for a deb install', () => {
    const steps = stepsFor({ method: 'deb' })

    expect(buildLinuxPackageInstallCommandMock).toHaveBeenCalledWith(
      'deb',
      expect.stringMatching(/^\/.*orca-1\.4\.200\.deb$/)
    )
    expect(steps[0]).toContain(RELEASE_URL)
    expect(steps[1]).toMatch(
      /^\/usr\/bin\/sudo \/usr\/bin\/apt install -- '\/.*orca-1\.4\.200\.deb'$/
    )
    expect(steps[2]).toContain('Restart the service unit that runs `orca serve`')
  })

  it('routes an rpm install through the same builder', () => {
    stepsFor({ method: 'rpm' })

    expect(buildLinuxPackageInstallCommandMock).toHaveBeenCalledWith(
      'rpm',
      expect.stringMatching(/orca-1\.4\.200\.rpm$/)
    )
  })

  it('swaps an AppImage through a staged name rather than writing it in place', () => {
    const steps = stepsFor({ method: 'appimage', appImagePath: '/opt/orca/orca-linux.AppImage' })

    expect(steps[0]).toContain('/opt/orca/orca-linux.AppImage.new')
    expect(steps[1]).toBe(
      "/usr/bin/sudo /usr/bin/mv -- '/opt/orca/orca-linux.AppImage.new' '/opt/orca/orca-linux.AppImage'"
    )
  })

  it('falls back to the documented procedure when no package manager is resolvable', () => {
    buildLinuxPackageInstallCommandMock.mockReturnValue({ ok: false, reason: 'no-sudo' })

    expect(stepsFor({ method: 'deb' })[0]).toContain(SERVE_UPGRADE_DOC_URL)
  })

  it('refuses to embed a version that is not filename-safe', () => {
    expect(stepsFor({ method: 'deb', latestVersion: '1.4.200; rm -rf /' })[0]).toContain(
      SERVE_UPGRADE_DOC_URL
    )
    expect(buildLinuxPackageInstallCommandMock).not.toHaveBeenCalled()
  })

  it('points an extracted tree and an unproven install at the documented procedure', () => {
    for (const method of ['extracted-appimage', 'unknown'] as const) {
      const steps = stepsFor({ method })
      expect(steps[0]).toContain(RELEASE_URL)
      expect(steps[1]).toContain(SERVE_UPGRADE_DOC_URL)
    }
  })

  it('keeps systemd vocabulary and the Linux guide off a non-Linux serve host', () => {
    expect(stepsFor({ method: 'unknown', platform: 'linux' }).join('\n')).toContain(
      'Restart the service unit that runs `orca serve`'
    )

    const windowsSteps = stepsFor({ method: 'unknown', platform: 'win32' }).join('\n')
    expect(windowsSteps).toContain('Windows service or scheduled task')
    expect(windowsSteps).not.toContain('service unit')
    expect(windowsSteps).not.toContain('headless-linux-server')

    const macSteps = stepsFor({ method: 'unknown', platform: 'darwin' }).join('\n')
    expect(macSteps).toContain('launchd job or supervisor')
    expect(macSteps).not.toContain('headless-linux-server')
  })

  it('links the Linux guide only on Linux', () => {
    expect(getServeUpgradeDocUrl('linux')).toBe(SERVE_UPGRADE_DOC_URL)
    expect(getServeUpgradeDocUrl('win32')).toBe('https://www.onorca.dev/docs/remote-servers')
    expect(getServeUpgradeDocUrl('darwin')).toBe('https://www.onorca.dev/docs/remote-servers')
  })

  it('sends a repackaged install to its own package manager, not the release page', () => {
    const steps = stepsFor({ method: 'externally-managed' })

    expect(steps.join('\n')).not.toContain(RELEASE_URL)
    expect(steps[0]).toContain('1.4.200')
    expect(steps[1]).toContain('Update through whichever package manager installed Orca')
    expect(buildLinuxPackageInstallCommandMock).not.toHaveBeenCalled()
  })

  it('never emits a step Orca could run for the operator', () => {
    const allSteps = [
      ...stepsFor({ method: 'deb' }),
      ...stepsFor({ method: 'appimage', appImagePath: '/opt/orca/orca-linux.AppImage' })
    ]

    expect(allSteps.filter((step) => step.includes('sudo'))).toHaveLength(2)
    expect(allSteps.some((step) => step.includes('systemctl restart'))).toBe(false)
  })
})
