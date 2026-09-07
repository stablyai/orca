import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  collectServiceFiles,
  formatFindings,
  inferScopeFromPath,
  isServiceCommand,
  parseServiceCommandArgs,
  printService
} from './orcad-service-command'

describe('flag routing', () => {
  // B1: these flags are handled before the native preflight, so a normal start must not be
  // diverted by them — and orcad's own parseArgs would reject them outright if they leaked.
  it('leaves a normal server start alone', () => {
    expect(isServiceCommand(['--port', '6800', '--json'])).toBe(false)
    expect(isServiceCommand([])).toBe(false)
  })

  it('claims the invocation for either service flag', () => {
    expect(isServiceCommand(['--print-service'])).toBe(true)
    expect(isServiceCommand(['--doctor'])).toBe(true)
  })
})

describe('argument parsing', () => {
  it('defaults to a system-scope loopback service', () => {
    const options = parseServiceCommandArgs(['--print-service'])
    expect(options).toMatchObject({ scope: 'system', bind: '127.0.0.1', port: 6800 })
    expect(options.user).toBeUndefined()
  })

  it('reads every override', () => {
    const options = parseServiceCommandArgs([
      '--print-service',
      '--scope',
      'user',
      '--user',
      'orca',
      '--node',
      '/usr/bin/node',
      '--port',
      '7000',
      '--bind',
      '0.0.0.0',
      '--orcad',
      '/opt/orcad/orcad.js',
      '--service-path',
      '/tmp/orcad.service',
      '--no-probe'
    ])
    expect(options).toEqual({
      scope: 'user',
      user: 'orca',
      nodePath: '/usr/bin/node',
      port: 7000,
      bind: '0.0.0.0',
      servicePath: '/tmp/orcad.service',
      orcadPath: '/opt/orcad/orcad.js',
      noProbe: true
    })
  })

  it('rejects values it cannot act on rather than guessing', () => {
    expect(() => parseServiceCommandArgs(['--scope', 'global'])).toThrow(/--scope/)
    expect(() => parseServiceCommandArgs(['--port', 'ssh'])).toThrow(/--port/)
    expect(() => parseServiceCommandArgs(['--user'])).toThrow(/--user/)
    expect(() => parseServiceCommandArgs(['--node'])).toThrow(/--node/)
    expect(() => parseServiceCommandArgs(['--orcad'])).toThrow(/--orcad/)
    expect(() => parseServiceCommandArgs(['--service-path'])).toThrow(/--service-path/)
  })

  // Silently dropping these is how `--user-data` came to be recommended by the tool's own
  // socket-budget remedy: an operator ran it, got exit 0 and an [OK], and had changed
  // nothing. `--json` is the same shape — real on `orca supervisor doctor`, absent here.
  it('rejects a flag it does not implement instead of ignoring it', () => {
    expect(() => parseServiceCommandArgs(['--doctor', '--user-data', '/tmp/x'])).toThrow(
      /Unknown argument: --user-data/
    )
    expect(() => parseServiceCommandArgs(['--doctor', '--json'])).toThrow(
      /Unknown argument: --json/
    )
  })

  // The mode flags travel in the same argv this parses, so they are not "unknown".
  it('accepts the mode flags it is invoked through', () => {
    expect(() => parseServiceCommandArgs(['--print-service'])).not.toThrow()
    expect(() => parseServiceCommandArgs(['--doctor', '--no-probe'])).not.toThrow()
  })

  // A value consumed by its flag must not then be re-read as an argument.
  it('does not mistake a flag value for an unknown flag', () => {
    expect(() =>
      parseServiceCommandArgs(['--doctor', '--service-path', '/tmp/--json.service'])
    ).not.toThrow()
  })
})

describe('which orcad the unit will exec', () => {
  // argv[1] is orcad's own entry only when orcad is the process running this. Reached through
  // `orca supervisor print` it is the CLI's entry, and the unit came out pinning
  // `ExecStart=<node> .../cli/index.js --bind ... --json` — the orca CLI handed orcad's flags,
  // which exits before it serves anything. Silent at generation time, and only visible later
  // as a unit that will not start.
  function generating(argv1: string, args: string[]): Promise<string> {
    const originalArgv1 = process.argv[1]
    const chunks: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk))
      return true
    })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.argv[1] = argv1
    return Promise.resolve(printService(args))
      .then(() => chunks.join(''))
      .finally(() => {
        process.argv[1] = originalArgv1
        stdout.mockRestore()
        stderr.mockRestore()
      })
  }

  it.runIf(process.platform !== 'win32')(
    'refuses rather than pinning whatever entry point happens to be running',
    async () => {
      await expect(generating('/opt/orca/out/cli/index.js', ['--print-service'])).rejects.toThrow(
        /--orcad/
      )
    }
  )

  it.runIf(process.platform !== 'win32')('takes the explicit path when given one', async () => {
    const unit = await generating('/opt/orca/out/cli/index.js', [
      '--print-service',
      '--orcad',
      '/opt/orcad/orcad.js',
      '--user',
      'orca'
    ])
    expect(/^ExecStart=.*$/m.exec(unit)?.[0]).toContain('/opt/orcad/orcad.js')
    expect(unit).not.toContain('cli/index.js')
  })

  it.runIf(process.platform !== 'win32')(
    'still trusts argv[1] when orcad is the process',
    async () => {
      const unit = await generating('/opt/orcad/orcad.js', ['--print-service', '--user', 'orca'])
      expect(/^ExecStart=.*$/m.exec(unit)?.[0]).toContain('/opt/orcad/orcad.js')
    }
  )
})

describe('scope inference', () => {
  // Mislabelling a user-scope file as system makes the audit report its correct missing
  // run-as account as critical.
  it('reads user scope out of the conventional paths', () => {
    expect(inferScopeFromPath('/home/orca/.config/systemd/user/orcad.service')).toBe('user')
    expect(inferScopeFromPath('/Users/orca/Library/LaunchAgents/dev.onorca.orcad.plist')).toBe(
      'user'
    )
  })

  it('treats everything else as system scope', () => {
    expect(inferScopeFromPath('/etc/systemd/system/orcad.service')).toBe('system')
    expect(inferScopeFromPath('/Library/LaunchDaemons/dev.onorca.orcad.plist')).toBe('system')
    expect(inferScopeFromPath('/tmp/scratch.service')).toBe('system')
  })
})

describe('finding output', () => {
  it('indents a remedy under its finding', () => {
    const text = formatFindings([
      {
        code: 'kill_mode_missing',
        severity: 'critical',
        message: 'No KillMode.',
        remedy: 'Regenerate.'
      },
      { code: 'user_data_agrees', severity: 'ok', message: 'Root pinned.' }
    ])
    expect(text).toBe('[CRITICAL] No KillMode.\n         Regenerate.\n[OK] Root pinned.')
  })
})

/**
 * Presence and readability are different answers, and `existsSync` only reports the first:
 * it succeeds on a file the caller cannot open, because a traversable parent is enough.
 *
 * These run only as non-root by necessity, not by preference — uid 0 ignores the mode bits,
 * so the unreadable file simply reads fine and the case cannot exist. Exercised as uid 1026
 * on the Synology box where the original was found.
 */
describe('discovery separates unreadable from absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-discovery-'))
  afterAll(() => {
    try {
      chmodSync(join(dir, 'orcad.service'), 0o600)
    } catch {
      // Already gone, or never created because the test was skipped.
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it.runIf(process.getuid?.() !== 0)('records a present-but-unreadable candidate', () => {
    const path = join(dir, 'orcad.service')
    writeFileSync(path, '[Service]\nExecStart=/bin/true\n', 'utf8')
    chmodSync(path, 0o000)

    const { files, unreadable } = collectServiceFiles('systemd', [path])

    expect(files.map((f) => f.path)).not.toContain(path)
    expect(unreadable.map((u) => u.path)).toContain(path)
    expect(unreadable.find((u) => u.path === path)?.reason).toBe('EACCES')
  })

  it('reports a path that truly is not there as neither found nor unreadable', () => {
    const path = join(dir, 'absent.service')
    const { files, unreadable } = collectServiceFiles('systemd', [path])
    expect(files.map((f) => f.path)).not.toContain(path)
    expect(unreadable.map((u) => u.path)).not.toContain(path)
  })

  it('reads a candidate it can open', () => {
    const path = join(dir, 'readable.service')
    writeFileSync(path, '[Service]\nKillMode=process\n', 'utf8')
    const { files, unreadable } = collectServiceFiles('systemd', [path])
    expect(files.map((f) => f.path)).toContain(path)
    expect(unreadable.map((u) => u.path)).not.toContain(path)
  })

  // An explicit path SELECTS; it does not extend the conventional list. While it extended,
  // naming the definition conventional discovery already finds — the obvious way to ask for a
  // report on your actual install — collected that one file twice, and `auditDuplicates` then
  // called it `multiple_services_one_root` at CRITICAL with exit 1 while silently skipping
  // every live probe as ambiguous. Asserting the exact result rather than `toContain` is the
  // point: the old behaviour also "contained" the path, and only an equality check sees the
  // conventional candidates that came along with it.
  it('audits only the named definition, not the conventional locations as well', () => {
    const path = join(dir, 'selected.service')
    writeFileSync(path, '[Service]\nKillMode=process\n', 'utf8')
    const { files } = collectServiceFiles('systemd', [path])
    expect(files.map((f) => f.path)).toEqual([path])
  })
})
