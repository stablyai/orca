import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveCliCommand } from '../../shared/shell/command-resolution/node-cli-command-resolution'
import { resolveAcpLaunchCommand } from '../acp/launch/acp-launch-command'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe('Windows agy install directory discovery', () => {
  it('finds a Windows fallback install and gives an explicit PATH entry precedence', () => {
    const home = makeTempDir('orca-agy-win-path-')
    const pathBin = join(home, 'custom-bin')
    const pathAgy = join(pathBin, 'agy.exe')
    const fallbackBin = join(home, 'AppData', 'Local', 'agy', 'bin')
    const fallbackAgy = join(fallbackBin, 'agy.exe')
    mkdirSync(pathBin, { recursive: true })
    mkdirSync(fallbackBin, { recursive: true })
    writeFileSync(pathAgy, '')
    writeFileSync(fallbackAgy, '')

    expect(resolveCliCommand('agy', { platform: 'win32', pathEnv: '', homePath: home })).toBe(
      fallbackAgy
    )
    expect(resolveCliCommand('agy', { platform: 'win32', pathEnv: pathBin, homePath: home })).toBe(
      pathAgy
    )
  })

  it('resolves host ACP launches from a custom LocalAppData agy install on Windows', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const root = makeTempDir('orca-agy-localappdata-')
    const home = join(root, 'home')
    const localAppData = join(root, 'custom-local')
    const agyExe = join(localAppData, 'agy', 'bin', 'agy.exe')
    mkdirSync(home, { recursive: true })
    mkdirSync(join(localAppData, 'agy', 'bin'), { recursive: true })
    writeFileSync(agyExe, '')

    const resolved = resolveAcpLaunchCommand(
      ANTIGRAVITY_LAUNCH_SPEC.hostBackend.spec,
      { PATH: '', LocalAppData: localAppData },
      { homePath: home, dataDirectory: null }
    )
    expect(resolved.command).toBe(agyExe)
  })

  it('ignores relative LOCALAPPDATA values', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const root = makeTempDir('orca-agy-dirs-')
    const hostSpec = ANTIGRAVITY_LAUNCH_SPEC.hostBackend.spec
    const defaultLocal = join(root, 'AppData', 'Local')

    expect(
      hostSpec.installDirectories({ env: { LOCALAPPDATA: 'relative\\path' }, homePath: root })
    ).toEqual([join(defaultLocal, 'agy', 'bin'), join(root, '.local', 'bin')])
  })

  it('keeps only ~/.local/bin on non-Windows hosts', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const home = '/home/tester'
    expect(
      ANTIGRAVITY_LAUNCH_SPEC.hostBackend.spec.installDirectories({
        env: { LOCALAPPDATA: '/ignored' },
        homePath: home
      })
    ).toEqual([join(home, '.local', 'bin')])
  })
})
