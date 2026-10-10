import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { faults } = vi.hoisted(() => ({
  faults: { readPath: '', linkPath: '', mutatePath: '', reads: 0 }
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === faults.readPath) {
        throw new Error('policy read denied')
      }
      if (args[0] === faults.mutatePath && ++faults.reads === 2) {
        actual.writeFileSync(faults.mutatePath, 'changed')
      }
      return actual.readFileSync(...args)
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (args[1] === faults.linkPath) {
        throw new Error('publication interrupted')
      }
      return actual.linkSync(...args)
    }
  }
})

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: homedirMock
}))
import { syncSystemCodexResourcesIntoManagedHome } from './codex-home-paths'

let root: string
let system: string
let first: string
let second: string
function files(home: string): string[] {
  return readdirSync(join(home, 'rules'))
    .filter((name) => name.endsWith('.rules'))
    .sort()
}
function contents(home: string): string {
  return files(home)
    .map((name) => readFileSync(join(home, 'rules', name), 'utf8'))
    .join('\n')
}
function imported(name: string, index = 0): string {
  return `orca-global-${String(index).padStart(10, '0')}-${createHash('sha256').update(name).digest('hex').slice(0, 32)}.rules`
}
beforeEach(() => {
  faults.readPath = ''
  faults.linkPath = ''
  faults.mutatePath = ''
  faults.reads = 0
  root = mkdtempSync(join(tmpdir(), 'orca-rules-'))
  homedirMock.mockReturnValue(root)
  system = join(root, '.codex')
  first = join(root, 'first')
  second = join(root, 'second')
  for (const home of [system, first, second]) {
    mkdirSync(join(home, 'rules'), { recursive: true })
  }
})
afterEach(() => {
  faults.readPath = ''
  faults.linkPath = ''
  faults.mutatePath = ''
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('managed Codex rule scope', () => {
  it('loads global rules alongside an existing account rules directory', () => {
    writeFileSync(
      join(system, 'rules', 'default.rules'),
      'prefix_rule(pattern=["global"], decision="forbidden")\n'
    )
    writeFileSync(
      join(first, 'rules', 'default.rules'),
      'prefix_rule(pattern=["account"], decision="allow")\n'
    )
    syncSystemCodexResourcesIntoManagedHome(first)
    expect(contents(first)).toContain('decision="forbidden"')
    expect(readFileSync(join(first, 'rules', 'default.rules'), 'utf8')).toContain('["account"]')
  })
  it('keeps newly saved approvals in the selected account', () => {
    writeFileSync(
      join(system, 'rules', 'default.rules'),
      'prefix_rule(pattern=["global"], decision="prompt")\n'
    )
    syncSystemCodexResourcesIntoManagedHome(first)
    syncSystemCodexResourcesIntoManagedHome(second)
    writeFileSync(
      join(first, 'rules', 'default.rules'),
      'prefix_rule(pattern=["first-only"], decision="allow")\n'
    )
    expect(contents(first)).toContain('["global"]')
    expect(contents(second)).not.toContain('["first-only"]')
    expect(contents(system)).not.toContain('["first-only"]')
    expect(existsSync(join(second, 'rules', 'default.rules'))).toBe(false)
  })
})

it('refreshes changed globals and removes deleted imports without touching account rules', () => {
  const global = join(system, 'rules', 'old.rules')
  writeFileSync(global, 'old')
  writeFileSync(join(first, 'rules', 'default.rules'), 'account')
  syncSystemCodexResourcesIntoManagedHome(first)
  writeFileSync(global, 'new')
  syncSystemCodexResourcesIntoManagedHome(first)
  expect(contents(first)).not.toContain('old')
  expect(contents(first)).toContain('new')
  rmSync(global)
  writeFileSync(join(system, 'rules', 'renamed.rules'), 'renamed')
  syncSystemCodexResourcesIntoManagedHome(first)
  expect(files(first).sort()).toEqual(['default.rules', imported('renamed.rules')])
  rmSync(join(system, 'rules'), { recursive: true })
  syncSystemCodexResourcesIntoManagedHome(first)
  expect(contents(first)).toBe('account')
})

it('refuses a colliding user file or a changed imported file without overwriting it', () => {
  writeFileSync(join(system, 'rules', 'default.rules'), 'global')
  const importedPath = join(first, 'rules', imported('default.rules'))
  writeFileSync(importedPath, 'user')
  expect(() => syncSystemCodexResourcesIntoManagedHome(first)).toThrow('launch stopped')
  expect(readFileSync(importedPath, 'utf8')).toBe('user')
  rmSync(importedPath)
  syncSystemCodexResourcesIntoManagedHome(first)
  writeFileSync(importedPath, 'edited')
  expect(() => syncSystemCodexResourcesIntoManagedHome(first)).toThrow('launch stopped')
  expect(readFileSync(importedPath, 'utf8')).toBe('edited')
})

it.skipIf(process.platform === 'win32')(
  'refuses destination symlinks without changing the system or another home',
  () => {
    writeFileSync(join(system, 'rules', 'default.rules'), 'global')
    rmSync(join(first, 'rules'), { recursive: true })
    symlinkSync(join(system, 'rules'), join(first, 'rules'))
    expect(() => syncSystemCodexResourcesIntoManagedHome(first)).toThrow('launch stopped')
    expect(files(system)).toEqual(['default.rules'])
    rmSync(join(first, 'rules'))
    mkdirSync(join(first, 'rules'))
    symlinkSync(
      join(system, 'rules', 'default.rules'),
      join(first, 'rules', imported('default.rules'))
    )
    expect(() => syncSystemCodexResourcesIntoManagedHome(first)).toThrow('launch stopped')
    expect(contents(system)).toBe('global')
  }
)

it('refuses unreadable or changing policy rather than removing the previous restrictions', () => {
  const global = join(system, 'rules', 'default.rules')
  writeFileSync(global, 'global')
  syncSystemCodexResourcesIntoManagedHome(first)
  faults.readPath = global
  expect(() => syncSystemCodexResourcesIntoManagedHome(first)).toThrow('policy read denied')
  faults.readPath = ''
  expect(contents(first)).toBe('global')
  faults.mutatePath = global
  expect(() => syncSystemCodexResourcesIntoManagedHome(first)).toThrow('launch stopped')
  faults.mutatePath = ''
  expect(contents(first)).toBe('global')
})

it('recovers a partially published policy using only journaled expected contents', () => {
  writeFileSync(join(system, 'rules', 'a.rules'), 'first')
  writeFileSync(join(system, 'rules', 'b.rules'), 'second')
  faults.linkPath = join(first, 'rules', imported('b.rules', 1))
  expect(() => syncSystemCodexResourcesIntoManagedHome(first)).toThrow('publication interrupted')
  expect(contents(first)).toBe('first')
  faults.linkPath = ''
  syncSystemCodexResourcesIntoManagedHome(first)
  expect(contents(first)).toBe('first\nsecond')
})

it('refuses corrupt ownership metadata and malformed source directories', () => {
  writeFileSync(join(system, 'rules', 'default.rules'), 'global')
  writeFileSync(join(first, '.orca-global-rule-imports.json'), '{}')
  expect(() => syncSystemCodexResourcesIntoManagedHome(first)).toThrow('launch stopped')
  expect(files(first)).toEqual([])
  rmSync(join(first, '.orca-global-rule-imports.json'))
  rmSync(join(system, 'rules'), { recursive: true })
  writeFileSync(join(system, 'rules'), 'not a directory')
  expect(() => syncSystemCodexResourcesIntoManagedHome(first)).toThrow('launch stopped')
})

it.skipIf(!process.env.ORCA_REAL_CODEX_POLICY_TEST)(
  'preserves shipping Codex forbidden/prompt precedence over account allowances',
  async () => {
    const { runProcess } = await import('../../shared/child-process/run-process')
    writeFileSync(
      join(system, 'rules', 'default.rules'),
      '# Global module\nprefix = ["policy-probe", "blocked"]\nprefix_rule(pattern=prefix, decision="forbidden")\n'
    )
    writeFileSync(
      join(system, 'rules', 'extra.rules'),
      'prefix_rule(pattern=["policy-probe", "asked"], decision="prompt")\nprefix_rule(pattern=["policy-probe", "global-allowed"], decision="allow")\n'
    )
    writeFileSync(
      join(first, 'rules', 'default.rules'),
      '# Account module uses the same variable name independently\nprefix = ["policy-probe"]\nprefix_rule(pattern=prefix, decision="allow")\n'
    )
    syncSystemCodexResourcesIntoManagedHome(first)
    for (const [argument, expected] of [
      ['blocked', 'forbidden'],
      ['asked', 'prompt'],
      ['global-allowed', 'allow']
    ]) {
      const result = await runProcess({
        program: process.env.ORCA_REAL_CODEX_POLICY_TEST ?? 'codex',
        args: [
          'execpolicy',
          'check',
          ...files(first).flatMap((name) => ['--rules', join(first, 'rules', name)]),
          '--',
          'policy-probe',
          argument
        ],
        env: { ...process.env, CODEX_HOME: first },
        timeoutMs: 10_000
      })
      expect(result.code, result.stderr).toBe(0)
      const parsed: unknown = JSON.parse(result.stdout)
      expect(parsed).toMatchObject({ decision: expected })
    }
  }
)

it('recovers the interrupted guarded rename window for both imports and the ownership journal', () => {
  writeFileSync(join(system, 'rules', 'default.rules'), 'before')
  syncSystemCodexResourcesIntoManagedHome(first)
  const rulePath = join(first, 'rules', imported('default.rules'))
  const manifestPath = join(first, '.orca-global-rule-imports.json')
  renameSync(rulePath, `${rulePath}.orca-guarded`)
  renameSync(manifestPath, `${manifestPath}.orca-guarded`)
  writeFileSync(join(system, 'rules', 'default.rules'), 'after')
  syncSystemCodexResourcesIntoManagedHome(first)
  expect(contents(first)).toBe('after')
  expect(existsSync(`${rulePath}.orca-guarded`)).toBe(false)
  expect(existsSync(`${manifestPath}.orca-guarded`)).toBe(false)
})

it('imports a valid near-limit global filename using a bounded target filename', () => {
  const name = `${'x'.repeat(245)}.rules`
  writeFileSync(join(system, 'rules', name), 'global')
  syncSystemCodexResourcesIntoManagedHome(first)
  expect(contents(first)).toBe('global')
  expect(files(first)[0].length).toBeLessThan(100)
})

it.skipIf(process.platform === 'win32')(
  'matches Codex discovery by ignoring symlink and directory rule entries',
  () => {
    writeFileSync(join(system, 'rules', 'default.rules'), 'regular')
    mkdirSync(join(system, 'rules', 'directory.rules'))
    writeFileSync(join(root, 'ignored'), 'unintended allowance')
    symlinkSync(join(root, 'ignored'), join(system, 'rules', 'linked.rules'))
    syncSystemCodexResourcesIntoManagedHome(first)
    expect(contents(first)).toBe('regular')
    expect(files(first)).toEqual([imported('default.rules')])
  }
)

it.skipIf(process.platform === 'win32')(
  'does not follow an unexpected guarded recovery symlink',
  () => {
    writeFileSync(join(system, 'rules', 'default.rules'), 'global')
    syncSystemCodexResourcesIntoManagedHome(first)
    const rulePath = join(first, 'rules', imported('default.rules'))
    symlinkSync(join(system, 'rules', 'default.rules'), `${rulePath}.orca-guarded`)
    expect(() => syncSystemCodexResourcesIntoManagedHome(first)).toThrow('launch stopped')
    expect(contents(system)).toBe('global')
    expect(contents(first)).toBe('global')
  }
)
