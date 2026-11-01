import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  adviceFor,
  collectSyncLaunchUses,
  countSyncSpawnUses,
  gatedSymbolsFor,
  main,
  prune
} from './check-main-sync-spawn-ratchet.mjs'

const roots = []
const BASELINE = 'config/main-sync-spawn-baseline.txt'

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function uses(source, file = 'src/main/consumer.ts') {
  return collectSyncLaunchUses(file, source)
}

function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-main-sync-spawn-'))
  roots.push(root)
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), source)
  }
  return root
}

function captureErrors() {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('main sync-spawn ratchet', () => {
  it('retains escaped imports and API names', () => {
    expect(
      uses(String.raw`import { \u0065xecSync as run } from 'node:child_\u0070rocess'; run('git')`)
    ).toEqual({ count: 1, symbols: ['execSync'] })
  })

  it('retains exports whose module name is inherited from the containing directory', () => {
    expect(uses("export * from '.'", 'src/main/wsl/consumer.ts')).toEqual({
      count: 4,
      symbols: ['getWslHome', 'isWslAvailable', 'listWslDistros', 'wslUncDirectoryExists']
    })
  })

  it.each([
    ["import { execFileSync } from 'node:child_process'\nexecFileSync('git')", 1, ['execFileSync']],
    [
      "import { execFileSync as run } from 'child_process'\nrun('git')\nrun('gh')",
      2,
      ['execFileSync']
    ],
    ["import * as cp from 'node:child_process'\ncp.spawnSync('git')", 1, ['spawnSync']],
    ["import cp from 'child_process'\ncp['execSync']('git')", 1, ['execSync']],
    ["import cp = require('child_process')\ncp.execFileSync('git')", 1, ['execFileSync']],
    ["require('node:child_process').execSync('git')", 1, ['execSync']],
    [
      "const cp = require('child_process')\nconst alias = cp\nalias.spawnSync('git')",
      1,
      ['spawnSync']
    ],
    ["const { spawnSync: run } = require('node:child_process')\nrun('git')", 1, ['spawnSync']],
    ["const { execSync } = await import('node:child_process')\nexecSync('git')", 1, ['execSync']],
    ["(await import('child_process')).execFileSync('git')", 1, ['execFileSync']],
    ["export { spawnSync } from 'node:child_process'", 1, ['spawnSync']],
    ["import { execSync } from 'child_process'\nexport { execSync }", 1, ['execSync']],
    [
      "import { execSync } from 'child_process'\nqueue.push(execSync, { execSync })",
      2,
      ['execSync']
    ],
    [
      "import { runProcessSync } from '@orca/process-host'\nconst run = options.run ?? runProcessSync\nrun(a)\nrun(b)",
      3,
      ['runProcessSync']
    ],
    [
      "import { getWslHome, listWslDistros } from './wsl.ts'\nconst read = sync ? getWslHome : listWslDistros\nread()",
      3,
      ['getWslHome', 'listWslDistros']
    ],
    [
      "import * as acl from '..\\\\shared\\\\secure-path-windows-acl'\nacl.restrictWindowsPathSync(p, true)",
      1,
      ['restrictWindowsPathSync']
    ],
    [
      "const { execSync } = require('child_process')\nconst run = execSync\nrun('a')",
      2,
      ['execSync']
    ],
    [
      "function f() { const run = cp.execSync; run('a') }\nconst cp = require('child_process')",
      2,
      ['execSync']
    ],
    [
      "import { execFileSync } from 'child_process'\nclass A extends mixin(execFileSync) {}",
      1,
      ['execFileSync']
    ],
    [
      "import { runProcessSync } from '@orca/process-host'\nconst run = runProcessSync<string>",
      1,
      ['runProcessSync']
    ]
  ])('counts %s', (source, count, symbols) => {
    expect(uses(source)).toEqual({ count, symbols })
  })

  it.each([
    "import { execFileSync } from 'node:child_process'",
    "import { spawn, execFile } from 'node:child_process'\nspawn('git')",
    "import type { execFileSync } from 'node:child_process'\nexecFileSync('x')",
    "import { type spawnSync } from 'child_process'\nspawnSync('x')",
    "import * as cp from 'child_process'\ntype Run = typeof cp.execFileSync",
    "import { runProcessSync } from '@orca/process-host'\ntype O = { run?: typeof runProcessSync }",
    "import { runProcess } from '@orca/process-host'\nrunProcess(spec)",
    "import { runProcessSync } from '@orca/process-host/process-spec'\nrunProcessSync(spec)",
    "import { writeSecureFile } from './secure-file'\nwriteSecureFile(p, v)",
    "import { execFileSync } from 'child_process'\nconst o = { execFileSync: 1 }\no.execFileSync",
    'const other = { spawnSync() {} }\nother.spawnSync()',
    "// execFileSync('git')\nconst script = \"require('child_process').execSync('ls')\"",
    "import * as cp from 'child_process'\ncp.spawn('git')",
    "import { gitExecFileAsync } from './git/runner'\ngitExecFileAsync(['status'])"
  ])('ignores %s', (source) => {
    expect(uses(source)).toEqual({ count: 0, symbols: [] })
  })

  it.each([
    [
      "import { gitExecFileSync } from './git/runner'\ngitExecFileSync(['status'])",
      'gitExecFileSync'
    ],
    [
      "import { gitExecFileSync as git } from './git/command-runner/git-exec-file.js'\ngit([])",
      'gitExecFileSync'
    ],
    [
      "import { restrictWindowsPathSync } from '../shared/secure-path-windows-acl'\nrestrictWindowsPathSync(p, true)",
      'restrictWindowsPathSync'
    ],
    ["import { grantDirAcl } from './win32-utils'\ngrantDirAcl(dir)", 'grantDirAcl'],
    ["import { getWslHome } from './wsl'\ngetWslHome(distro)", 'getWslHome'],
    ["import { listWslDistros } from './wsl'\nlistWslDistros()", 'listWslDistros'],
    [
      "import { wslUncDirectoryExists } from './wsl'\nwslUncDirectoryExists(p)",
      'wslUncDirectoryExists'
    ],
    ["import { isWslAvailable } from './wsl'\nisWslAvailable()", 'isWslAvailable'],
    ["import { isWslAvailable } from './wsl-availability'\nisWslAvailable()", 'isWslAvailable'],
    ["import { isPwshAvailable } from './pwsh'\nisPwshAvailable()", 'isPwshAvailable']
  ])('gates the repo sync wrapper in %s', (source, symbol) => {
    expect(uses(source)).toEqual({ count: 1, symbols: [symbol] })
  })

  it('counts re-exports in the re-exporting module and internal calls in the defining one', () => {
    expect(
      uses(
        "export { gitExecFileAsync, gitExecFileSync } from './command-runner/git-exec-file'",
        'src/main/git/runner.ts'
      )
    ).toEqual({ count: 1, symbols: ['gitExecFileSync'] })
    expect(
      uses(
        'export function listWslDistros() { return [] }\nexport function first() { return listWslDistros()[0] }',
        'src/main/wsl.ts'
      )
    ).toEqual({ count: 1, symbols: ['listWslDistros'] })
  })

  it('resolves imports by the module they point at, not by name', () => {
    expect(
      uses(
        "import { restrictWindowsPathSync } from './secure-path-windows-acl'\nrestrictWindowsPathSync(p, true)",
        'src/shared/store.ts'
      )
    ).toEqual({
      count: 1,
      symbols: ['restrictWindowsPathSync']
    })
  })

  it('resolves backslash paths in both the importing file and the specifier', () => {
    expect([...(gatedSymbolsFor('src\\main\\foo\\x.ts', '..\\wsl') ?? [])]).toContain('getWslHome')
  })

  it.each(['import {', 'const broken = ;'])(
    'fails closed on source it cannot parse: %s',
    (source) => {
      expect(() => uses(source)).toThrow('Cannot parse src/main/consumer.ts')
    }
  )

  it('counts only production main and shared source', () => {
    const sync = "import { execSync } from 'node:child_process'\nexecSync('a')\nexecSync('b')"
    const { counts } = countSyncSpawnUses(
      new Map(
        Object.entries({
          'src/main/legacy.ts': sync,
          'src/shared/new.ts':
            "import { runProcessSync } from '@orca/process-host'\nrunProcessSync(s)",
          'src/main/clean.ts': "import { spawn } from 'node:child_process'\nspawn('a')",
          'src/main/consumer.test.ts': sync,
          'src/main/fixtures/script.ts': sync,
          'src/main/types.d.ts': sync,
          'src/cli/handlers/core.ts': sync,
          'src/relay/host.ts': sync
        })
      )
    )
    expect([...counts]).toEqual([
      ['src/main/legacy.ts', 2],
      ['src/shared/new.ts', 1]
    ])
  })

  it('gives each gated family its own advice', () => {
    expect(adviceFor(['execFileSync', 'runProcessSync'])).toBe(
      'execFileSync, runProcessSync: use runProcess or spawnProcess from @orca/process-host.'
    )
    expect(adviceFor(['restrictWindowsPathSync'])).toContain(
      "use restrictWindowsDirectory for a directory, or raise this file's count in config/main-sync-spawn-baseline.txt"
    )
    expect(adviceFor(['gitExecFileSync', 'grantDirAcl'])).toBe(
      'gitExecFileSync: use gitExecFileAsync. grantDirAcl: use grantDirAclAsync.'
    )
  })

  it('fails a new file and a rising count, and passes at the baseline count', () => {
    const one = "import { spawnSync } from 'node:child_process'\nspawnSync('a')"
    const root = tree({
      'src/main/launch.ts': one,
      'src/main/launch.test.ts': `${one}\nspawnSync('b')`,
      'src/renderer/src/view.ts': one,
      [BASELINE]: '# debt\n'
    })
    const error = captureErrors()
    expect(main(root)).toBe(1)
    expect(error.mock.calls.map(([line]) => line)).toEqual([
      '::error file=src/main/launch.ts::1 synchronous launch use(s), baseline allows 0. They block the main thread. spawnSync: use runProcess or spawnProcess from @orca/process-host.'
    ])
    writeFileSync(path.join(root, BASELINE), '1 src/main/launch.ts\n')
    expect(main(root)).toBe(0)
    writeFileSync(path.join(root, 'src/main/launch.ts'), `${one}\nspawnSync('b')`)
    error.mockClear()
    expect(main(root)).toBe(1)
    expect(error.mock.calls[0][0]).toContain('2 synchronous launch use(s), baseline allows 1.')
  })

  it('fails a lowered or stale count until it is pruned, and prune never raises', () => {
    const write =
      "import { restrictWindowsPathSync } from '../shared/secure-path-windows-acl'\nrestrictWindowsPathSync(a, b)\n"
    const root = tree({
      'src/main/store.ts': write,
      'src/main/clean.ts': 'export const done = true\n',
      'src/main/new.ts': write,
      'src/main/grown.ts': `${write}restrictWindowsPathSync(c, d)\n`,
      [BASELINE]:
        '# old header\n3 src/main/store.ts # tracked in #26754\n1 src/main/clean.ts\n1 src/main/grown.ts\n'
    })
    const error = captureErrors()
    expect(main(root)).toBe(1)
    const lines = error.mock.calls.map(([line]) => line)
    expect(lines[0]).toContain('src/main/grown.ts::2 synchronous launch use(s), baseline allows 1.')
    expect(lines[1]).toContain('src/main/new.ts::1 synchronous launch use(s), baseline allows 0.')
    expect(lines[1]).toContain('restrictWindowsPathSync: rewrites a DACL on the calling thread')
    expect(lines.slice(2)).toEqual([
      '::error file=src/main/clean.ts::0 synchronous launch use(s), baseline still allows 1. Run: pnpm check:main-sync-spawn-ratchet --prune',
      '::error file=src/main/store.ts::1 synchronous launch use(s), baseline still allows 3. Run: pnpm check:main-sync-spawn-ratchet --prune'
    ])
    prune(root)
    const pruned = readFileSync(path.join(root, BASELINE), 'utf8')
    expect(pruned).toContain('counts may only go DOWN')
    expect(pruned.split('\n').filter((line) => line && !line.startsWith('#'))).toEqual([
      '1 src/main/grown.ts',
      '1 src/main/store.ts # tracked in #26754'
    ])
    error.mockClear()
    expect(main(root)).toBe(1)
    expect(error.mock.calls.map(([line]) => line.split('::')[1])).toEqual([
      'error file=src/main/grown.ts',
      'error file=src/main/new.ts'
    ])
  })
})
