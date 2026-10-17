import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultDebugSettings } from '../../shared/default-global-settings'
import { debugAdapterApprovalKey } from '../../shared/debug-settings-types'
import {
  adapterForConfigType,
  adapterForLanguage,
  DAP_ADAPTERS,
  DAP_PORT_PLACEHOLDER,
  DAP_SOCKET_PLACEHOLDER,
  describeDebugAdapters,
  probeDebugpy,
  resolveDebugAdapter,
  type DapAdapterRow,
  type DapResolveOptions
} from './dap-adapter-registry'

function row(id: string): DapAdapterRow {
  const found = DAP_ADAPTERS.find((candidate) => candidate.id === id)
  if (!found) {
    throw new Error(`no row ${id}`)
  }
  return found
}

function makeExecutable(dir: string, name: string, body = '#!/bin/sh\nexit 0\n'): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

describe('dap-adapter-registry', () => {
  let root: string
  let bin: string
  let home: string
  let base: DapResolveOptions
  // Why win32 for misses: it skips the real /usr/local/bin and Homebrew dirs, so the host cannot leak a hit.
  let empty: DapResolveOptions

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-dap-registry-'))
    bin = join(root, 'bin')
    home = join(root, 'home')
    mkdirSync(bin)
    mkdirSync(home)
    base = { pathEnv: bin, platform: 'linux', homePath: home, env: {} }
    empty = {
      pathEnv: join(root, 'nothing'),
      platform: 'win32',
      homePath: home,
      env: {}
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves debugpy to python3 on PATH and keys the PYTHON binary with -m debugpy.adapter', async () => {
    const python = makeExecutable(bin, 'python3')
    const result = await resolveDebugAdapter(row('debugpy'), base)
    expect(result).toEqual({
      ok: true,
      binaryPath: python,
      args: ['-m', 'debugpy.adapter'],
      spawnArgs: ['-m', 'debugpy.adapter'],
      approvalKey: JSON.stringify(['debugpy', python, '-m', 'debugpy.adapter']),
      transport: 'stdio',
      repoLocal: false
    })
  })

  it('prefers the launch python, then the setting, then .venv, then python3', async () => {
    makeExecutable(bin, 'python3')
    const venv = makeExecutable(join(root, 'wt', '.venv', 'bin'), 'python')
    const setting = makeExecutable(join(root, 'setting'), 'python')
    const launch = makeExecutable(join(root, 'launch'), 'python')
    const worktreePath = join(root, 'wt')
    const pick = async (options: DapResolveOptions) => {
      const result = await resolveDebugAdapter(row('debugpy'), {
        ...base,
        worktreePath,
        ...options
      })
      return result.ok ? result.binaryPath : null
    }
    expect(await pick({})).toBe(venv)
    expect(await pick({ settings: { debugPythonPath: setting } })).toBe(setting)
    expect(
      await pick({
        settings: { debugPythonPath: setting },
        pythonOverride: launch
      })
    ).toBe(launch)
  })

  it('does not fall through when an explicitly chosen python is missing', async () => {
    makeExecutable(bin, 'python3')
    const result = await resolveDebugAdapter(row('debugpy'), {
      ...base,
      pythonOverride: join(root, 'missing', 'python')
    })
    expect(result).toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('resolves lldb-dap on PATH, and through xcrun on darwin only', async () => {
    const xcrunBin = makeExecutable(join(root, 'xcode'), 'lldb-dap')
    const xcrunFind = async (tool: string) => (tool === 'lldb-dap' ? `${xcrunBin}\n`.trim() : null)
    const viaXcrun = await resolveDebugAdapter(row('lldb-dap'), {
      ...base,
      platform: 'darwin',
      xcrunFind
    })
    expect(viaXcrun).toMatchObject({
      ok: true,
      binaryPath: xcrunBin,
      args: []
    })
    const linux = await resolveDebugAdapter(row('lldb-dap'), {
      ...base,
      xcrunFind
    })
    expect(linux).toMatchObject({ ok: false, reason: 'not-found' })

    const onPath = makeExecutable(bin, 'lldb-dap')
    const preferred = await resolveDebugAdapter(row('lldb-dap'), {
      ...base,
      platform: 'darwin',
      xcrunFind
    })
    expect(preferred).toMatchObject({ ok: true, binaryPath: onPath })
  })

  it('rejects an xcrun answer that is not a runnable file', async () => {
    const result = await resolveDebugAdapter(row('lldb-dap'), {
      ...base,
      platform: 'darwin',
      xcrunFind: async () => join(root, 'gone', 'lldb-dap')
    })
    expect(result).toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('resolves dlv on a unix socket with a path-free key that is identical across starts', async () => {
    const dlv = makeExecutable(bin, 'dlv')
    const first = await resolveDebugAdapter(row('dlv'), base)
    const second = await resolveDebugAdapter(row('dlv'), base)
    expect(first).toEqual({
      ok: true,
      binaryPath: dlv,
      args: ['dap', '--listen', `unix:${DAP_SOCKET_PLACEHOLDER}`],
      spawnArgs: ['dap', '--listen', 'unix:<socket>'],
      approvalKey: JSON.stringify(['dlv', dlv, 'dap', '--listen', 'unix:<socket>']),
      transport: 'socket',
      repoLocal: false
    })
    expect(second).toEqual(first)
  })

  it('keeps dlv on loopback tcp on Windows only, where a unix socket cannot be dialed', async () => {
    const dlv = makeExecutable(bin, 'dlv.exe')
    const resolved = await resolveDebugAdapter(row('dlv'), { ...base, platform: 'win32' })
    expect(resolved).toMatchObject({
      ok: true,
      binaryPath: dlv,
      args: ['dap', '--listen', `127.0.0.1:${DAP_PORT_PLACEHOLDER}`],
      spawnArgs: ['dap', '--listen', '127.0.0.1:0'],
      transport: 'tcp'
    })
  })

  it('finds js-debug only when dapDebugServer.js exists as a FILE', async () => {
    const node = makeExecutable(bin, 'node')
    const dataHome = join(root, 'data')
    const server = join(dataHome, 'js-debug', 'src', 'dapDebugServer.js')
    const options = { ...base, env: { XDG_DATA_HOME: dataHome } }

    expect(await resolveDebugAdapter(row('js-debug'), options)).toMatchObject({
      ok: false
    })
    mkdirSync(server, { recursive: true })
    expect(await resolveDebugAdapter(row('js-debug'), options)).toMatchObject({
      ok: false
    })
    rmSync(server, { recursive: true })
    writeFileSync(server, '')

    const first = await resolveDebugAdapter(row('js-debug'), options)
    // Never loopback TCP: dapDebugServer.js takes any local connection's launch, unauthenticated.
    expect(first).toEqual({
      ok: true,
      binaryPath: node,
      args: [server, '<socket>'],
      spawnArgs: [server, '<socket>'],
      approvalKey: JSON.stringify(['js-debug', node, server, '<socket>']),
      transport: 'socket',
      repoLocal: false
    })
    expect(await resolveDebugAdapter(row('js-debug'), options)).toEqual(first)
  })

  it('reads js-debug from ~/.local/share by default and from the setting when set', async () => {
    makeExecutable(bin, 'node')
    const defaultServer = join(home, '.local', 'share', 'js-debug', 'src', 'dapDebugServer.js')
    mkdirSync(join(defaultServer, '..'), { recursive: true })
    writeFileSync(defaultServer, '')
    expect(await resolveDebugAdapter(row('js-debug'), base)).toMatchObject({
      ok: true,
      args: [defaultServer, '<socket>']
    })

    const missing = { debugJsDebugServerPath: join(root, 'missing.js') }
    expect(
      await resolveDebugAdapter(row('js-debug'), {
        ...base,
        settings: missing
      })
    ).toMatchObject({ ok: false })
    const custom = join(root, 'custom.js')
    writeFileSync(custom, '')
    const configured = await resolveDebugAdapter(row('js-debug'), {
      ...base,
      settings: { debugJsDebugServerPath: custom }
    })
    expect(configured).toMatchObject({
      ok: true,
      args: [custom, '<socket>']
    })
  })

  it('carries an install hint for every row that is not found', async () => {
    const hints: Record<string, string> = {}
    for (const adapter of DAP_ADAPTERS) {
      const result = await resolveDebugAdapter(adapter, {
        ...empty,
        xcrunFind: async () => null
      })
      expect(result.ok).toBe(false)
      hints[adapter.id] = result.ok ? '' : result.hint
    }
    expect(hints.debugpy).toContain('pip install debugpy')
    expect(hints['lldb-dap']).toContain('Xcode command line tools')
    expect(hints.dlv).toContain('go install github.com/go-delve/delve/cmd/dlv@latest')
    expect(hints['js-debug']).toContain('js-debug-dap')
  })

  it('changes the key when the binary or the args change', () => {
    const key = debugAdapterApprovalKey('debugpy', '/a/python', ['-m', 'debugpy.adapter'])
    expect(key).toBe(JSON.stringify(['debugpy', '/a/python', '-m', 'debugpy.adapter']))
    expect(debugAdapterApprovalKey('debugpy', '/b/python', ['-m', 'debugpy.adapter'])).not.toBe(key)
    expect(debugAdapterApprovalKey('debugpy', '/a/python', ['-m', 'other'])).not.toBe(key)
    expect(debugAdapterApprovalKey('dlv', '/a/python', ['-m', 'debugpy.adapter'])).not.toBe(key)
  })

  it('lets no two rows claim one language or one config type', () => {
    const languages = DAP_ADAPTERS.flatMap((adapter) => adapter.languages)
    const configTypes = DAP_ADAPTERS.flatMap((adapter) => adapter.configTypes)
    expect(new Set(languages).size).toBe(languages.length)
    expect(new Set(configTypes).size).toBe(configTypes.length)
    expect(adapterForLanguage('python')?.id).toBe('debugpy')
    expect(adapterForLanguage('rust')?.id).toBe('lldb-dap')
    expect(adapterForLanguage('go')?.id).toBe('dlv')
    expect(adapterForLanguage('typescriptreact')?.id).toBe('js-debug')
    expect(adapterForConfigType('python')?.id).toBe('debugpy')
    expect(adapterForConfigType('lldb')?.id).toBe('lldb-dap')
    expect(adapterForConfigType('node')?.id).toBe('js-debug')
    expect(adapterForLanguage('cobol')).toBeUndefined()
  })

  it('pins the wire identity and launch defaults of each row', () => {
    const wire = DAP_ADAPTERS.map(({ id, adapterId, wireType, transport, launchDefaults }) => ({
      id,
      adapterId,
      wireType,
      transport,
      launchDefaults
    }))
    expect(wire).toEqual([
      {
        id: 'debugpy',
        adapterId: 'python',
        wireType: 'debugpy',
        transport: 'stdio',
        launchDefaults: { justMyCode: false, console: 'internalConsole' }
      },
      {
        id: 'lldb-dap',
        adapterId: 'lldb-dap',
        wireType: 'lldb-dap',
        transport: 'stdio',
        launchDefaults: {}
      },
      {
        id: 'dlv',
        adapterId: 'go',
        wireType: 'go',
        transport: 'socket',
        launchDefaults: { outputMode: 'remote' }
      },
      {
        id: 'js-debug',
        adapterId: 'pwa-node',
        wireType: 'pwa-node',
        transport: 'socket',
        launchDefaults: {}
      }
    ])
    const jsDebug = row('js-debug')
    expect([jsDebug.breakpointsBindLazily, jsDebug.usesChildSessions]).toEqual([true, true])
    for (const other of DAP_ADAPTERS.filter((adapter) => adapter.id !== 'js-debug')) {
      expect([other.breakpointsBindLazily, other.usesChildSessions]).toEqual([false, false])
    }
  })

  it('never answers a language from a config-only row, and leaves it out of the trust prompt', async () => {
    const configOnly: DapAdapterRow = {
      ...row('js-debug'),
      id: 'js-debug-chrome',
      languages: [],
      configTypes: ['chrome', 'pwa-chrome']
    }
    const table = [configOnly, ...DAP_ADAPTERS]
    expect(adapterForLanguage('javascript', table)?.id).toBe('js-debug')
    expect(adapterForLanguage('', table)).toBeUndefined()
    expect(adapterForConfigType('chrome', table)?.id).toBe('js-debug-chrome')
    const described = await describeDebugAdapters({ ...empty, xcrunFind: async () => null }, table)
    expect(described.map((entry) => entry.adapterId)).toEqual(DAP_ADAPTERS.map((a) => a.id))
  })

  it('describes the exact binary, args and key the trust prompt approves', async () => {
    const dlv = makeExecutable(bin, 'dlv')
    const described = await describeDebugAdapters(base)
    const dlvEntry = described.find((entry) => entry.adapterId === 'dlv')
    const resolved = await resolveDebugAdapter(row('dlv'), base)
    expect(dlvEntry).toMatchObject({
      binaryPath: dlv,
      args: resolved.ok ? resolved.args : undefined,
      approvalKey: resolved.ok ? resolved.approvalKey : undefined,
      hint: null
    })
    expect(described.find((entry) => entry.adapterId === 'debugpy')).toMatchObject({
      binaryPath: null,
      approvalKey: null,
      hint: expect.stringContaining('pip install debugpy')
    })
  })

  it('probes debugpy only for an approved key, and refuses to run anything otherwise', async () => {
    const marker = join(root, 'ran')
    const python = makeExecutable(bin, 'python3', `#!/bin/sh\ntouch '${marker}'\nexit 0\n`)
    const approvalKey = debugAdapterApprovalKey('debugpy', python, ['-m', 'debugpy.adapter'])
    expect(await probeDebugpy(python, { approvalKey, approvedKeys: [] })).toMatchObject({
      ok: false,
      reason: 'not-approved'
    })
    // Resolving an unapproved interpreter never runs it either.
    expect(await resolveDebugAdapter(row('debugpy'), base)).toMatchObject({ ok: true })
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'reports the pip hint through resolution when an approved interpreter cannot import debugpy',
    async () => {
      const python = makeExecutable(bin, 'python3', '#!/bin/sh\nexit 1\n')
      const approvalKey = debugAdapterApprovalKey('debugpy', python, ['-m', 'debugpy.adapter'])
      const resolved = await resolveDebugAdapter(row('debugpy'), {
        ...base,
        approvedKeys: [approvalKey]
      })
      expect(resolved).toEqual({
        ok: false,
        reason: 'not-found',
        hint: expect.stringContaining('pip install debugpy')
      })
      const approval = { approvalKey: 'k', approvedKeys: ['k'] }
      expect(await probeDebugpy(join(root, 'no-such-python'), approval)).toMatchObject({
        ok: false,
        reason: 'not-found'
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'probes with exactly -E -c "import debugpy", the adapter env allowlist and a cwd outside the repo',
    async () => {
      const record = join(root, 'probe.txt')
      // Exits 0 only for the exact probe argv; records argv, cwd and env.
      const python = makeExecutable(
        bin,
        'python3',
        `#!/bin/sh\n{ printf '%s|' "$@"; echo; pwd; env; } > '${record}'\n` +
          `[ "$1" = "-E" ] && [ "$2" = "-c" ] && [ "$3" = "import debugpy" ] && [ $# -eq 3 ]\n`
      )
      const approvalKey = debugAdapterApprovalKey('debugpy', python, ['-m', 'debugpy.adapter'])
      process.env.ORCA_PROBE_SECRET_TOKEN = 'sentinel-secret'
      try {
        const resolved = await resolveDebugAdapter(row('debugpy'), {
          ...base,
          approvedKeys: [approvalKey]
        })
        expect(resolved).toMatchObject({ ok: true, binaryPath: python })
      } finally {
        delete process.env.ORCA_PROBE_SECRET_TOKEN
      }
      const [argv, cwd, ...env] = readFileSync(record, 'utf8').split('\n')
      expect(argv).toBe('-E|-c|import debugpy|')
      expect(realpathSync(cwd)).toBe(realpathSync(homedir()))
      expect(env.join('\n')).not.toContain('sentinel-secret')
      expect(env.some((line) => line.startsWith('PATH='))).toBe(true)
    }
  )

  it('marks a binary inside the worktree, or a link from it, as repo-local', async () => {
    const worktree = join(root, 'wt')
    const venvPython = makeExecutable(join(worktree, '.venv', 'bin'), 'python')
    const local = await resolveDebugAdapter(row('debugpy'), { ...base, worktreePath: worktree })
    expect(local).toMatchObject({ ok: true, binaryPath: venvPython, repoLocal: true })
    rmSync(venvPython)
    const system = makeExecutable(bin, 'python3')
    symlinkSync(system, venvPython)
    // The link resolves outside the repo, but the repo controls where it points.
    const linked = await resolveDebugAdapter(row('debugpy'), { ...base, worktreePath: worktree })
    expect(linked).toMatchObject({ ok: true, repoLocal: true })
    rmSync(join(worktree, '.venv'), { recursive: true })
    const outside = await resolveDebugAdapter(row('debugpy'), { ...base, worktreePath: worktree })
    expect(outside).toMatchObject({ ok: true, binaryPath: system, repoLocal: false })
    const described = await describeDebugAdapters({ ...base, worktreePath: worktree })
    expect(described.find((entry) => entry.adapterId === 'debugpy')?.repoLocal).toBe(false)
  })

  it('ships empty debug defaults in the global settings', () => {
    expect(getDefaultDebugSettings()).toEqual({
      debugEnabledRepos: [],
      debugAdapterApprovals: {},
      debugPythonPath: '',
      debugJsDebugServerPath: '',
      debugLaunchApprovals: {}
    })
  })
})
