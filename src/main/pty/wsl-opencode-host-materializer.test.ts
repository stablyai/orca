import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

import {
  ensureShellReadyWrappersAt,
  getBashShellReadyRcfileContent
} from '../providers/local-pty-shell-ready'
import { getWslOpenCodeShellMaterializerBlock } from './wsl-opencode-shell-materializer-block'
import { ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV } from '../../shared/wsl-opencode-materializer-contract'
import {
  configureWslOpenCodeShellMaterializer,
  _internals,
  materializeWslOpenCodeShellScript
} from './wsl-opencode-shell-materializer'

describe('WSL OpenCode host materializer', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wsl-opencode-host-materializer-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('ships the current generated plugin source in an idempotent host-side script', () => {
    const first = materializeWslOpenCodeShellScript(root)
    const second = materializeWslOpenCodeShellScript(root)

    expect(first).toBe(second)
    expect(first).not.toBeNull()
    const script = readFileSync(first!, 'utf8')
    expect(script).toContain('ORCA_OPENCODE_PLUGIN_EOF')
    const lines = script.split('\n')
    const payloadEnd = lines.indexOf('ORCA_OPENCODE_PLUGIN_EOF')
    expect(payloadEnd).toBeGreaterThan(0)
    const decodedPlugin = Buffer.from(lines[payloadEnd - 1] ?? '', 'base64').toString('utf8')
    expect(decodedPlugin).toContain('/hook/opencode')
  })

  it('rewrites a changed cached host script without rename-overwrite support', () => {
    const target = join(root, 'cached-materializer.sh')
    writeFileSync(target, 'stale script', { mode: 0o640 })
    const initialMode = lstatSync(target).mode & 0o777
    // This path blocked the former temp-plus-rename strategy on every platform.
    mkdirSync(`${target}.${process.pid}.tmp`)

    _internals.writeIfChanged(target, 'current script')

    expect(readFileSync(target, 'utf8')).toBe('current script')
    expect(lstatSync(target).mode & 0o777).toBe(initialMode)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects an equal-content host materializer symlink',
    () => {
      const external = join(root, 'external.sh')
      const target = join(root, 'cached-materializer.sh')
      writeFileSync(external, 'current script')
      symlinkSync(external, target)

      expect(() => _internals.writeIfChanged(target, 'current script')).toThrow(
        'target is not a regular file'
      )
    }
  )

  it('strips host overlays and stays usable when the host script cannot be written', () => {
    const unusableUserData = join(root, 'not-a-directory')
    writeFileSync(unusableUserData, 'blocks mkdir')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env = {
      OPENCODE_CONFIG_DIR: 'C:\\host-overlay',
      ORCA_OPENCODE_CONFIG_DIR: 'C:\\host-overlay',
      ORCA_OPENCODE_SOURCE_CONFIG_DIR: 'C:\\user-config',
      [ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV]: 'C:\\stale-guest-source',
      ORCA_WSL_OPENCODE_MATERIALIZER: 'C:\\stale-materializer.sh'
    }

    expect(() => configureWslOpenCodeShellMaterializer(env, unusableUserData)).not.toThrow()
    expect(env).toEqual({})
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WSL materializer unavailable'))
  })

  it('captures a guest source idempotently while stripping host overlay variables', () => {
    const env: Record<string, string> = {
      WSLENV: 'KEEP/u:OPENCODE_CONFIG_DIR/u',
      OPENCODE_CONFIG_DIR: '/home/jin/company-opencode',
      ORCA_OPENCODE_CONFIG_DIR: 'C:\\host-overlay',
      ORCA_OPENCODE_SOURCE_CONFIG_DIR: 'C:\\host-source'
    }

    configureWslOpenCodeShellMaterializer(env, root)
    configureWslOpenCodeShellMaterializer(env, root)

    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(env.ORCA_OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(env.ORCA_OPENCODE_SOURCE_CONFIG_DIR).toBeUndefined()
    expect(env[ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV]).toBe('/home/jin/company-opencode')
    expect(env.ORCA_WSL_OPENCODE_MATERIALIZER).toBe(
      join(root, 'wsl-opencode-materializer', 'materialize.sh')
    )
  })

  it('preserves a resolved guest source omitted from a daemon spawn request', () => {
    const env: Record<string, string> = {}

    configureWslOpenCodeShellMaterializer(env, root, '/home/jin/company-opencode')

    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(env[ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV]).toBe('/home/jin/company-opencode')
    expect(env.ORCA_WSL_OPENCODE_MATERIALIZER).toBe(
      join(root, 'wsl-opencode-materializer', 'materialize.sh')
    )
  })

  it('rejects a resolved host path omitted from a daemon spawn request', () => {
    const env: Record<string, string> = {}

    configureWslOpenCodeShellMaterializer(env, root, 'C:\\Users\\jin\\opencode')

    expect(env[ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV]).toBeUndefined()
    expect(env.ORCA_WSL_OPENCODE_MATERIALIZER).toBe(
      join(root, 'wsl-opencode-materializer', 'materialize.sh')
    )
  })

  it('fails open to an intentional guest config when host materialization is unavailable', () => {
    const unusableUserData = join(root, 'not-a-directory')
    writeFileSync(unusableUserData, 'blocks mkdir')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env: Record<string, string> = {
      WSLENV: 'OPENCODE_CONFIG_DIR/u',
      OPENCODE_CONFIG_DIR: '/home/jin/company-opencode'
    }

    configureWslOpenCodeShellMaterializer(env, unusableUserData)

    expect(env.OPENCODE_CONFIG_DIR).toBe('/home/jin/company-opencode')
    expect(env.WSLENV).toBe('OPENCODE_CONFIG_DIR/u')
    expect(env[ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV]).toBeUndefined()
    expect(env.ORCA_WSL_OPENCODE_MATERIALIZER).toBeUndefined()
  })

  it('runs after local-wrapper guest startup and before bash/zsh readiness', () => {
    const materializerBlock = getWslOpenCodeShellMaterializerBlock()
    const bashWrapper = getBashShellReadyRcfileContent()
    const profileIndex = bashWrapper.indexOf('source "$HOME/.bash_profile"')
    const materializerIndex = bashWrapper.indexOf(materializerBlock)
    const markerIndex = bashWrapper.indexOf('orca-shell-ready')

    expect(profileIndex).toBeGreaterThanOrEqual(0)
    expect(materializerIndex).toBeGreaterThan(profileIndex)
    expect(markerIndex).toBeGreaterThan(materializerIndex)

    const wrapperRoot = join(root, 'shell-ready')
    ensureShellReadyWrappersAt(wrapperRoot)
    const zshLogin = readFileSync(join(wrapperRoot, 'zsh', '.zlogin'), 'utf8')
    const zshMaterializerIndex = zshLogin.indexOf(materializerBlock)

    expect(zshMaterializerIndex).toBeGreaterThan(zshLogin.indexOf('source "$_orca_home/.zlogin"'))
    expect(zshLogin.indexOf('orca-shell-ready')).toBeGreaterThan(zshMaterializerIndex)
  })
})
