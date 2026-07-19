import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WSL_HOOK_RELAY_INSTANCE_ENV,
  wslHookRelayEndpointFilePath
} from '../../shared/wsl-hook-relay-contract'
import { ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV } from '../../shared/wsl-opencode-materializer-contract'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

import { _internals } from './wsl-opencode-shell-materializer'

const PLUGIN_SOURCE = 'export const OrcaOpenCodeStatusPlugin = async () => ({})\n'
const PRINT_MATERIALIZER_ENV =
  '. "$1"; printf "CONFIG=%s\\nORCA=%s\\n" "${OPENCODE_CONFIG_DIR:-}" "${ORCA_OPENCODE_CONFIG_DIR:-}"'
const POSIX_SHELL_CANDIDATES = ['/bin/bash', '/bin/zsh', '/bin/sh', '/bin/dash'] as const
const AVAILABLE_POSIX_SHELLS =
  process.platform === 'win32'
    ? []
    : POSIX_SHELL_CANDIDATES.filter(
        (shell) => spawnSync(shell, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
      )
const AVAILABLE_BASH_ZSH_SHELLS = AVAILABLE_POSIX_SHELLS.filter(
  (shell) => shell === '/bin/bash' || shell === '/bin/zsh'
)
const describePosix = AVAILABLE_POSIX_SHELLS.includes('/bin/bash') ? describe : describe.skip

function sourceMaterializerAsync(
  scriptPath: string,
  env: Record<string, string>
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      '/bin/bash',
      ['-c', PRINT_MATERIALIZER_ENV, 'orca-wsl-materializer-test', scriptPath],
      { env: { PATH: process.env.PATH ?? '', ...env } }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function sourceMaterializer(
  shell: string,
  scriptPath: string,
  env: Record<string, string>,
  prelude = ''
): {
  configDir: string
  orcaConfigDir: string
  sourceDir: string
  endpointFile: string
  stderr: string
} {
  const result = spawnSync(
    shell,
    [
      '-c',
      `${prelude}\n. "$1"; printf "CONFIG=%s\\nORCA=%s\\nSOURCE=%s\\nENDPOINT=%s\\n" "\${OPENCODE_CONFIG_DIR:-}" "\${ORCA_OPENCODE_CONFIG_DIR:-}" "\${ORCA_OPENCODE_SOURCE_CONFIG_DIR:-}" "\${ORCA_AGENT_HOOK_ENDPOINT:-}"`,
      'orca-wsl-materializer-test',
      scriptPath
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env }
    }
  )
  expect(result.status, result.stderr).toBe(0)
  const values = new Map(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1)]
      })
  )
  return {
    configDir: values.get('CONFIG') ?? '',
    orcaConfigDir: values.get('ORCA') ?? '',
    sourceDir: values.get('SOURCE') ?? '',
    endpointFile: values.get('ENDPOINT') ?? '',
    stderr: result.stderr
  }
}

describePosix('WSL OpenCode shell materializer', () => {
  let homeDir: string
  let materializerPath: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'wsl-opencode-materializer-'))
    materializerPath = join(homeDir, 'materialize.sh')
    writeFileSync(materializerPath, _internals.shellMaterializerSource(PLUGIN_SOURCE))
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  it.each(AVAILABLE_POSIX_SHELLS)(
    'mirrors the final guest OPENCODE_CONFIG_DIR without touching user files in %s',
    (shell) => {
      const sourceDir = join(homeDir, 'company opencode')
      mkdirSync(join(sourceDir, 'plugins'), { recursive: true })
      writeFileSync(join(sourceDir, 'opencode.json'), '{"model":"company/model"}')
      writeFileSync(join(sourceDir, '.company-policy'), 'preserve me')
      writeFileSync(join(sourceDir, 'plugins', 'user-plugin.js'), 'user plugin')
      writeFileSync(
        join(sourceDir, 'plugins', 'orca-opencode-status.js'),
        'user-owned same-name plugin'
      )

      const result = sourceMaterializer(shell, materializerPath, {
        HOME: homeDir,
        OPENCODE_CONFIG_DIR: sourceDir
      })

      expect(result.configDir, result.stderr).toMatch(
        /\/\.orca-wsl\/opencode-config-overlays\/[a-f0-9]{16}-[0-9]+-[0-9]+$/
      )
      expect(result.configDir.startsWith(homeDir)).toBe(true)
      expect(result.orcaConfigDir).toBe(result.configDir)
      expect(result.sourceDir).toBe(sourceDir)
      expect(lstatSync(join(result.configDir, 'opencode.json')).isSymbolicLink()).toBe(true)
      expect(lstatSync(join(result.configDir, '.company-policy')).isSymbolicLink()).toBe(true)
      expect(lstatSync(join(result.configDir, 'plugins', 'user-plugin.js')).isSymbolicLink()).toBe(
        true
      )
      expect(
        readFileSync(join(result.configDir, 'plugins', 'orca-opencode-status.js'), 'utf8')
      ).toBe(PLUGIN_SOURCE)
      expect(readFileSync(join(sourceDir, 'plugins', 'orca-opencode-status.js'), 'utf8')).toBe(
        'user-owned same-name plugin'
      )
    }
  )

  it('prefers a PTY-scoped guest source and derives the first-PTY relay endpoint', () => {
    const rcSourceDir = join(homeDir, 'rc-config')
    const requestedSourceDir = join(homeDir, 'requested-config')
    mkdirSync(rcSourceDir)
    mkdirSync(requestedSourceDir)
    writeFileSync(join(rcSourceDir, 'rc.json'), '{}')
    writeFileSync(join(requestedSourceDir, 'requested.json'), '{}')

    const result = sourceMaterializer('/bin/bash', materializerPath, {
      HOME: homeDir,
      OPENCODE_CONFIG_DIR: rcSourceDir,
      [ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV]: requestedSourceDir,
      [WSL_HOOK_RELAY_INSTANCE_ENV]: 'test-instance'
    })

    expect(result.sourceDir).toBe(requestedSourceDir)
    expect(existsSync(join(result.configDir, 'requested.json'))).toBe(true)
    expect(existsSync(join(result.configDir, 'rc.json'))).toBe(false)
    expect(result.endpointFile).toBe(wslHookRelayEndpointFilePath(homeDir, 'test-instance'))
  })

  it.each([undefined, 'Bad Key', `a${'b'.repeat(64)}`])(
    'keeps the existing endpoint for an absent or invalid relay key (%s)',
    (instanceKey) => {
      const env: Record<string, string> = {
        HOME: homeDir,
        ORCA_AGENT_HOOK_ENDPOINT: '/mnt/c/host/endpoint.cmd'
      }
      if (instanceKey !== undefined) {
        env[WSL_HOOK_RELAY_INSTANCE_ENV] = instanceKey
      }

      const result = sourceMaterializer('/bin/bash', materializerPath, env)

      expect(result.endpointFile).toBe('/mnt/c/host/endpoint.cmd')
    }
  )

  it('creates a plugin-only additive root when the guest has no explicit config dir', () => {
    const xdgConfigDir = join(homeDir, '.config', 'opencode')
    mkdirSync(join(xdgConfigDir, 'plugins'), { recursive: true })
    writeFileSync(join(xdgConfigDir, 'opencode.json'), '{"username":"guest"}')
    writeFileSync(join(xdgConfigDir, 'plugins', 'user-plugin.js'), 'load exactly once')

    const result = sourceMaterializer('/bin/bash', materializerPath, { HOME: homeDir })

    expect(result.sourceDir).toBe('')
    expect(result.configDir).toMatch(/-[d]efault$/)
    expect(existsSync(join(result.configDir, 'opencode.json'))).toBe(false)
    expect(existsSync(join(result.configDir, 'plugins', 'user-plugin.js'))).toBe(false)
    expect(readFileSync(join(result.configDir, 'plugins', 'orca-opencode-status.js'), 'utf8')).toBe(
      PLUGIN_SOURCE
    )
    expect(readFileSync(join(xdgConfigDir, 'plugins', 'user-plugin.js'), 'utf8')).toBe(
      'load exactly once'
    )
  })

  it.each(AVAILABLE_BASH_ZSH_SHELLS)(
    'keeps an explicit default config root out of the additive overlay in %s',
    (shell) => {
      const defaultConfigDir = join(homeDir, '.config', 'opencode')
      mkdirSync(join(defaultConfigDir, 'plugins'), { recursive: true })
      writeFileSync(join(defaultConfigDir, 'opencode.json'), '{"default":true}')
      writeFileSync(join(defaultConfigDir, 'plugins', 'user-plugin.js'), 'load once')

      const result = sourceMaterializer(shell, materializerPath, {
        HOME: homeDir,
        OPENCODE_CONFIG_DIR: defaultConfigDir
      })

      expect(result.sourceDir).toBe(defaultConfigDir)
      expect(result.configDir).toMatch(/-default$/)
      expect(existsSync(join(result.configDir, 'opencode.json'))).toBe(false)
      expect(existsSync(join(result.configDir, 'plugins', 'user-plugin.js'))).toBe(false)
      expect(readFileSync(join(defaultConfigDir, 'plugins', 'user-plugin.js'), 'utf8')).toBe(
        'load once'
      )
    }
  )

  it('recognizes the XDG_CONFIG_HOME OpenCode root as the default', () => {
    const xdgHome = join(homeDir, 'xdg-config')
    const defaultConfigDir = join(xdgHome, 'opencode')
    mkdirSync(join(defaultConfigDir, 'plugins'), { recursive: true })
    writeFileSync(join(defaultConfigDir, 'plugins', 'user-plugin.js'), 'xdg plugin')

    const result = sourceMaterializer('/bin/bash', materializerPath, {
      HOME: homeDir,
      XDG_CONFIG_HOME: xdgHome,
      OPENCODE_CONFIG_DIR: defaultConfigDir
    })

    expect(result.sourceDir).toBe(defaultConfigDir)
    expect(result.configDir).toMatch(/-default$/)
    expect(existsSync(join(result.configDir, 'plugins', 'user-plugin.js'))).toBe(false)
  })

  it('removes stale mirrored config and plugin links while preserving runtime files', () => {
    const sourceDir = join(homeDir, 'changing-config')
    mkdirSync(join(sourceDir, 'plugins'), { recursive: true })
    writeFileSync(join(sourceDir, 'old-config.json'), '{}')
    writeFileSync(join(sourceDir, 'plugins', 'old-plugin.js'), 'old')
    const first = sourceMaterializer('/bin/bash', materializerPath, {
      HOME: homeDir,
      OPENCODE_CONFIG_DIR: sourceDir
    })
    mkdirSync(join(first.configDir, 'node_modules', 'runtime'), { recursive: true })
    writeFileSync(join(first.configDir, 'node_modules', 'runtime', 'index.js'), 'runtime')

    unlinkSync(join(sourceDir, 'old-config.json'))
    unlinkSync(join(sourceDir, 'plugins', 'old-plugin.js'))
    writeFileSync(join(sourceDir, 'new-config.json'), '{}')
    writeFileSync(join(sourceDir, 'plugins', 'new-plugin.js'), 'new')
    const second = sourceMaterializer('/bin/bash', materializerPath, {
      HOME: homeDir,
      OPENCODE_CONFIG_DIR: sourceDir
    })

    expect(second.configDir).toBe(first.configDir)
    expect(readdirSync(second.configDir)).not.toContain('old-config.json')
    expect(readdirSync(join(second.configDir, 'plugins'))).not.toContain('old-plugin.js')
    expect(lstatSync(join(second.configDir, 'new-config.json')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(second.configDir, 'plugins', 'new-plugin.js')).isSymbolicLink()).toBe(
      true
    )
    expect(
      readFileSync(join(second.configDir, 'node_modules', 'runtime', 'index.js'), 'utf8')
    ).toBe('runtime')
  })

  it('accepts a benign same-target symlink creation race', () => {
    const sourceDir = join(homeDir, 'race-config')
    mkdirSync(join(sourceDir, 'plugins'), { recursive: true })
    writeFileSync(join(sourceDir, 'opencode.json'), '{}')
    writeFileSync(join(sourceDir, 'plugins', 'user-plugin.js'), 'plugin')

    const result = sourceMaterializer(
      '/bin/bash',
      materializerPath,
      { HOME: homeDir, OPENCODE_CONFIG_DIR: sourceDir },
      'ln() { command ln "$@"; return 1; }'
    )

    expect(result.orcaConfigDir).toBe(result.configDir)
    expect(lstatSync(join(result.configDir, 'opencode.json')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(result.configDir, 'plugins', 'user-plugin.js')).isSymbolicLink()).toBe(
      true
    )
  })

  it('materializes the same overlay from simultaneous shell processes', async () => {
    const sourceDir = join(homeDir, 'simultaneous-config')
    mkdirSync(join(sourceDir, 'plugins'), { recursive: true })
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(sourceDir, `config-${index}.json`), '{}')
      writeFileSync(join(sourceDir, 'plugins', `plugin-${index}.js`), 'plugin')
    }

    const results = await Promise.all([
      sourceMaterializerAsync(materializerPath, {
        HOME: homeDir,
        [ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV]: sourceDir
      }),
      sourceMaterializerAsync(materializerPath, {
        HOME: homeDir,
        [ORCA_WSL_OPENCODE_SOURCE_CONFIG_DIR_ENV]: sourceDir
      })
    ])

    expect(
      results.map((result) => result.status),
      results.map((result) => result.stderr).join('\n')
    ).toEqual([0, 0])
    const configDirs = results.map((result) => /ORCA=(.*)/.exec(result.stdout)?.[1])
    expect(configDirs[0]).toBeTruthy()
    expect(configDirs[1]).toBe(configDirs[0])
  })

  it('fails open instead of accepting a conflicting overlay symlink', () => {
    const sourceDir = join(homeDir, 'conflict-config')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'opencode.json'), '{"source":true}')
    const first = sourceMaterializer('/bin/bash', materializerPath, {
      HOME: homeDir,
      OPENCODE_CONFIG_DIR: sourceDir
    })
    const conflictingFile = join(homeDir, 'conflicting.json')
    writeFileSync(conflictingFile, '{"wrong":true}')
    unlinkSync(join(first.configDir, 'opencode.json'))
    symlinkSync(conflictingFile, join(first.configDir, 'opencode.json'))

    const second = sourceMaterializer('/bin/bash', materializerPath, {
      HOME: homeDir,
      OPENCODE_CONFIG_DIR: sourceDir
    })

    expect(second.configDir).toBe(sourceDir)
    expect(second.orcaConfigDir).toBe('')
    expect(readFileSync(conflictingFile, 'utf8')).toBe('{"wrong":true}')
  })

  it('refuses to write through a pre-created managed plugins symlink', () => {
    const sourceDir = join(homeDir, 'linked-overlay-config')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'opencode.json'), '{}')
    const first = sourceMaterializer('/bin/bash', materializerPath, {
      HOME: homeDir,
      OPENCODE_CONFIG_DIR: sourceDir
    })
    const externalPlugins = join(homeDir, 'external-plugins')
    mkdirSync(externalPlugins)
    writeFileSync(join(externalPlugins, 'sentinel.js'), 'preserve')
    rmSync(join(first.configDir, 'plugins'), { recursive: true })
    symlinkSync(externalPlugins, join(first.configDir, 'plugins'), 'dir')

    const second = sourceMaterializer('/bin/bash', materializerPath, {
      HOME: homeDir,
      OPENCODE_CONFIG_DIR: sourceDir
    })

    expect(second.configDir).toBe(sourceDir)
    expect(second.orcaConfigDir).toBe('')
    expect(readdirSync(externalPlugins)).toEqual(['sentinel.js'])
  })

  it('fails open and leaves a relative guest config value unchanged', () => {
    const sourceDir = 'relative/config'
    const result = sourceMaterializer('/bin/bash', materializerPath, {
      HOME: homeDir,
      OPENCODE_CONFIG_DIR: sourceDir
    })

    expect(result.configDir).toBe(sourceDir)
    expect(result.orcaConfigDir).toBe('')
    expect(result.sourceDir).toBe('')
  })

  it('rejects a relative HOME instead of writing outside the guest home', () => {
    const result = sourceMaterializer('/bin/sh', materializerPath, { HOME: 'relative-home' })

    expect(result.configDir).toBe('')
    expect(result.orcaConfigDir).toBe('')
    expect(result.sourceDir).toBe('')
  })

  it('fails open and leaves a missing absolute guest config value unchanged', () => {
    const sourceDir = join(homeDir, 'missing')
    const result = sourceMaterializer('/bin/bash', materializerPath, {
      HOME: homeDir,
      OPENCODE_CONFIG_DIR: sourceDir
    })

    expect(result.configDir).toBe(sourceDir)
    expect(result.orcaConfigDir).toBe('')
    expect(result.sourceDir).toBe('')
  })

  it('keeps guest overlays isolated by distro home', () => {
    const ubuntuHome = join(homeDir, 'ubuntu-home')
    const debianHome = join(homeDir, 'debian-home')
    mkdirSync(ubuntuHome)
    mkdirSync(debianHome)

    const ubuntu = sourceMaterializer('/bin/bash', materializerPath, { HOME: ubuntuHome })
    const debian = sourceMaterializer('/bin/bash', materializerPath, { HOME: debianHome })

    expect(ubuntu.configDir.startsWith(`${ubuntuHome}/.orca-wsl/`)).toBe(true)
    expect(debian.configDir.startsWith(`${debianHome}/.orca-wsl/`)).toBe(true)
    expect(ubuntu.configDir).not.toBe(debian.configDir)
  })

  it('leaves the original guest config active when plugin decoding fails', () => {
    const sourceDir = join(homeDir, 'guest-config')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'opencode.json'), '{"preserved":true}')

    const result = sourceMaterializer(
      '/bin/bash',
      materializerPath,
      { HOME: homeDir, OPENCODE_CONFIG_DIR: sourceDir },
      'base64() { return 127; }'
    )

    expect(result.configDir).toBe(sourceDir)
    expect(result.orcaConfigDir).toBe('')
    expect(result.sourceDir).toBe('')
    expect(readFileSync(join(sourceDir, 'opencode.json'), 'utf8')).toBe('{"preserved":true}')
  })

  it("does not change the caller's Bash nullglob setting", () => {
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        'shopt -u nullglob; source "$1"; shopt -q nullglob && printf enabled || printf disabled',
        'orca-wsl-materializer-test',
        materializerPath
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: homeDir } }
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('disabled')
  })
})
