import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  admitWslGit,
  noteWslGitFailure,
  resetWslGitAdmissionForTests,
  routeLocalGitOptions,
  setBackgroundWslGitGate,
  setLocalGitRuntimeRouter,
  WslGitSkippedError
} from './local-git-runtime-route'

const originalPlatform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  setLocalGitRuntimeRouter((cwd) => (cwd.startsWith('C:\\wsl-project') ? 'Ubuntu' : undefined))
})

afterEach(() => {
  setLocalGitRuntimeRouter(null)
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

describe('routeLocalGitOptions', () => {
  it("runs a WSL-runtime project's Git in its distro when the caller passed only a folder", () => {
    expect(routeLocalGitOptions({ cwd: String.raw`C:\wsl-project\src` })).toEqual({
      cwd: String.raw`C:\wsl-project\src`,
      wslDistro: 'Ubuntu'
    })
  })

  it.each([
    ['a host-Git project', { cwd: String.raw`C:\windows-project` }],
    ['an explicit distro', { cwd: String.raw`C:\wsl-project`, wslDistro: 'Debian' }],
    ['a deliberate host-Git call', { cwd: String.raw`C:\wsl-project`, hostGit: true as const }],
    ['a UNC folder, which names its own distro', { cwd: String.raw`\\wsl.localhost\Ubuntu\x` }]
  ])('leaves %s as it is', (_name, options) => {
    expect(routeLocalGitOptions(options)).toBe(options)
  })

  it('does nothing off Windows or without a router', () => {
    const options = { cwd: String.raw`C:\wsl-project` }
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    expect(routeLocalGitOptions(options)).toBe(options)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    setLocalGitRuntimeRouter(null)
    expect(routeLocalGitOptions(options)).toBe(options)
  })
})

describe('admitWslGit', () => {
  afterEach(() => {
    resetWslGitAdmissionForTests()
  })

  const routed = { cwd: String.raw`C:\wsl-project`, wslDistro: 'Ubuntu' }
  const missing = new Error('There is no distribution with the supplied name.')

  it('fails at once, without wsl.exe, for a distro WSL just said is missing', async () => {
    noteWslGitFailure(routed, missing, 1_000)
    await expect(admitWslGit(routed, 2_000)).rejects.toBeInstanceOf(WslGitSkippedError)
    expect(admitWslGit(routed, 31_001)).toBeNull()
  })

  it('remembers only a missing distro, not any other failure', () => {
    noteWslGitFailure(routed, new Error('fatal: not a git repository'), 1_000)
    expect(admitWslGit(routed, 2_000)).toBeNull()
  })

  it("holds background Git on a drive project until the project's distro runs", async () => {
    const running = new Set<string>()
    setBackgroundWslGitGate(async (distro) => running.has(distro))
    await expect(admitWslGit({ ...routed, admissionTier: 'background' })).rejects.toThrow('stopped')
    running.add('Ubuntu')
    await expect(admitWslGit({ ...routed, admissionTier: 'background' })).resolves.toBeUndefined()
    // Foreground Git, and a folder inside the distro, start it as before.
    expect(admitWslGit({ ...routed, admissionTier: 'interactive' })).toBeNull()
    expect(
      admitWslGit({
        cwd: String.raw`\\wsl.localhost\Ubuntu\x`,
        wslDistro: 'Ubuntu',
        admissionTier: 'background'
      })
    ).toBeNull()
  })
})

describe('the missing-distro cache with the router off', () => {
  afterEach(() => {
    resetWslGitAdmissionForTests()
  })

  it('is never armed or consulted, so every call runs as before D1c', () => {
    const routed = { cwd: String.raw`C:\wsl-project`, wslDistro: 'Ubuntu' }
    setLocalGitRuntimeRouter(null)
    noteWslGitFailure(routed, new Error('WSL_E_DISTRO_NOT_FOUND'), 1_000)
    expect(admitWslGit(routed, 2_000)).toBeNull()
    // Turning the router on later finds nothing recorded while it was off.
    setLocalGitRuntimeRouter(() => 'Ubuntu')
    expect(admitWslGit(routed, 2_000)).toBeNull()
  })
})
