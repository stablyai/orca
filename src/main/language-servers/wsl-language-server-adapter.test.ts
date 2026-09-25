import { describe, expect, it, beforeEach } from 'vitest'
import type { runProcess } from '../../shared/child-process/run-process'
import {
  normalizeHostFileKey,
  selectHostAdapter,
  resetHostAdapterCacheForTests
} from './language-server-host-adapter'
import {
  resolveWslClangdPath,
  resolveWslClangdVersionGate,
  buildWslClangdSpawnArgs
} from './wsl-clangd-resolution'

describe('selectHostAdapter — host-adapter selection (spec §4)', () => {
  beforeEach(() => {
    resetHostAdapterCacheForTests()
  })

  it('selects the native adapter for a Windows drive worktree root', () => {
    const adapter = selectHostAdapter('D:\\zwf\\Projects\\repo')
    expect(adapter.kind).toBe('native')
  })

  it('selects the WSL adapter for a wsl.localhost UNC worktree root', () => {
    const adapter = selectHostAdapter('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo')
    expect(adapter.kind).toBe('wsl')
  })

  it('selects the WSL adapter for the legacy wsl$ UNC spelling', () => {
    const adapter = selectHostAdapter('\\\\wsl$\\Ubuntu\\home\\u\\repo')
    expect(adapter.kind).toBe('wsl')
  })

  it('memoizes the WSL adapter per distro so probes are shared across sessions', () => {
    const a = selectHostAdapter('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo-a')
    const b = selectHostAdapter('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo-b')
    expect(a).toBe(b)
  })

  it('uses distinct adapters for distinct distros', () => {
    const ubuntu = selectHostAdapter('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo')
    const debian = selectHostAdapter('\\\\wsl.localhost\\Debian\\home\\u\\repo')
    expect(ubuntu).not.toBe(debian)
  })

  it('selects native for a POSIX local worktree root', () => {
    const adapter = selectHostAdapter('/home/u/repo')
    expect(adapter.kind).toBe('native')
  })
})

describe('normalizeHostFileKey — universal key (native + WSL)', () => {
  it('uppercases Windows drive letters', () => {
    expect(normalizeHostFileKey('d:/proj/a.cpp')).toBe('D:\\proj\\a.cpp')
  })

  it('case-folds WSL UNC prefixes', () => {
    expect(normalizeHostFileKey('\\\\wsl.localhost\\Ubuntu\\home\\a.cpp')).toBe(
      normalizeHostFileKey('\\\\WSL.LOCALHOST\\ubuntu\\home\\a.cpp')
    )
  })

  it('passes POSIX paths through', () => {
    expect(normalizeHostFileKey('/home/u/a.cpp')).toBe('/home/u/a.cpp')
  })
})

describe('WSL adapter path mappers (bound to a distro)', () => {
  beforeEach(() => {
    resetHostAdapterCacheForTests()
  })

  it('maps UNC -> guest URI and back through the adapter interface', () => {
    const adapter = selectHostAdapter('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo')
    const uri = adapter.pathToLspUri('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo\\src\\a.cpp')
    expect(uri).toBe('file:///home/u/repo/src/a.cpp')
    expect(adapter.lspUriToPath(uri)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo\\src\\a.cpp')
  })

  it('uses the adapter normalizeKey for the session/document key', () => {
    const adapter = selectHostAdapter('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo')
    expect(adapter.normalizeKey('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo\\a.cpp')).toBe(
      '//wsl.localhost/ubuntu/home/u/repo/a.cpp'
    )
  })

  it('resolves the clangd program as wsl.exe (the spawn binary)', () => {
    const adapter = selectHostAdapter('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo')
    // wsl.exe path or the bare name fallback — either way it is the spawn entry.
    expect(adapter.resolveClangdProgram()).toMatch(/wsl\.exe$/i)
  })
})

describe('WSL clangd version gate (guest probe, spec D7)', () => {
  beforeEach(() => {
    resetHostAdapterCacheForTests()
  })

  function fakeRunner(stdout: string, code: number | null = 0): typeof runProcess {
    return (async () => ({
      code,
      signal: null,
      stdout,
      stderr: '',
      timedOut: false
    })) as unknown as typeof runProcess
  }

  it('resolveWslClangdPath parses the POSIX PATH lookup result', async () => {
    // Direct unit test of the path-lookup parser: stdout = resolved path.
    const path = await resolveWslClangdPath(
      'Ubuntu',
      { path: '/usr/bin', home: '/home/u', envBinary: '/usr/bin/env' },
      fakeRunner('/usr/bin/clangd\n')
    )
    expect(path).toBe('/usr/bin/clangd')
  })

  it('resolveWslClangdPath returns null when clangd is absent (empty stdout)', async () => {
    const path = await resolveWslClangdPath(
      'Ubuntu',
      { path: '/usr/bin', home: '/home/u', envBinary: '/usr/bin/env' },
      fakeRunner('')
    )
    expect(path).toBeNull()
  })

  it('resolveWslClangdPath returns null when the probe times out', async () => {
    const path = await resolveWslClangdPath(
      'Ubuntu',
      { path: '/usr/bin', home: '/home/u', envBinary: '/usr/bin/env' },
      (async () => ({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: true
      })) as unknown as typeof runProcess
    )
    expect(path).toBeNull()
  })

  it('resolveWslClangdVersionGate classifies the guest banner', async () => {
    const gate = await resolveWslClangdVersionGate(
      'Ubuntu',
      { path: '/usr/bin', home: '/home/u', envBinary: '/usr/bin/env' },
      '/usr/bin/clangd',
      fakeRunner('clangd version 18.1.0\n')
    )
    expect(gate).toEqual({ kind: 'ok', major: 18, message: null })
  })

  it('resolveWslClangdVersionGate rejects a clangd below the floor', async () => {
    const gate = await resolveWslClangdVersionGate(
      'Ubuntu',
      { path: '/usr/bin', home: '/home/u', envBinary: '/usr/bin/env' },
      '/usr/bin/clangd',
      fakeRunner('clangd version 11.0.0\n')
    )
    expect(gate.kind).toBe('reject')
    expect(gate.major).toBe(11)
    expect(gate.message).toMatch(/clangd 12|install/i)
  })

  it('resolveWslClangdVersionGate suggests upgrade for 12-15', async () => {
    const gate = await resolveWslClangdVersionGate(
      'Ubuntu',
      { path: '/usr/bin', home: '/home/u', envBinary: '/usr/bin/env' },
      '/usr/bin/clangd',
      fakeRunner('clangd version 13.0.1\n')
    )
    expect(gate.kind).toBe('suggest-upgrade')
    expect(gate.major).toBe(13)
  })

  it('resolveWslClangdVersionGate rejects when the binary is absent (ENOENT)', async () => {
    const runner = (async () => {
      throw new Error('spawn wsl.exe ENOENT')
    }) as unknown as typeof runProcess
    const gate = await resolveWslClangdVersionGate(
      'Ubuntu',
      { path: '/usr/bin', home: '/home/u', envBinary: '/usr/bin/env' },
      '/usr/bin/clangd',
      runner
    )
    expect(gate.kind).toBe('reject')
    expect(gate.major).toBeNull()
  })
})

describe('WSL buildLaunch — argv shape (spec D8: --exec, no shell, no fence)', () => {
  beforeEach(() => {
    resetHostAdapterCacheForTests()
  })

  it('buildWslClangdSpawnArgs produces wsl.exe --exec + env prefix + clangd (no shell)', () => {
    const args = buildWslClangdSpawnArgs(
      'Ubuntu',
      { path: '/usr/local/bin:/usr/bin', home: '/home/u', envBinary: '/usr/bin/env' },
      '/usr/bin/clangd',
      ['--log=info']
    )
    // --exec skips wsl.exe's $name expansion; the env binary applies PATH/HOME.
    expect(args[0]).toBe('-d')
    expect(args[1]).toBe('Ubuntu')
    expect(args[2]).toBe('--exec')
    expect(args[3]).toBe('/usr/bin/env')
    expect(args[4]).toBe('PATH=/usr/local/bin:/usr/bin')
    expect(args[5]).toBe('HOME=/home/u')
    expect(args[6]).toBe('/usr/bin/clangd')
    expect(args[7]).toBe('--log=info')
  })

  it('buildWslClangdSpawnArgs omits the env prefix when the guest env probe failed', () => {
    const args = buildWslClangdSpawnArgs('Ubuntu', null, '/usr/bin/clangd', ['--log=info'])
    // Degraded: runs clangd on the distro's default PATH (no env prefix).
    expect(args[0]).toBe('-d')
    expect(args[1]).toBe('Ubuntu')
    expect(args[2]).toBe('--exec')
    expect(args[3]).toBe('/usr/bin/clangd')
    expect(args[4]).toBe('--log=info')
  })
})
