import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { collectSyncLaunchUses, main, prune } from './check-main-sync-spawn-ratchet.mjs'

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
      "import { getWslHome, listWslDistros } from './wsl/discovery/distro-catalog.ts'\nconst read = sync ? getWslHome : listWslDistros\nread()",
      3,
      ['getWslHome', 'listWslDistros']
    ],
    [
      "import * as acl from '..\\\\shared\\\\secure-storage\\\\secure-path-windows-acl'\nacl.restrictWindowsPathSync(p, true)",
      1,
      ['restrictWindowsPathSync']
    ],
    [
      "const { execSync } = require('child_process')\nconst run = execSync\nrun('a')",
      1,
      ['execSync']
    ],
    [
      "function f() { const run = cp.execSync; run('a') }\nconst cp = require('child_process')",
      1,
      ['execSync']
    ],
    [
      "import { execFileSync } from 'child_process'\nclass A extends mixin(execFileSync) {}",
      1,
      ['execFileSync']
    ],
    [
      "import { runProcessSync } from '@orca/process-host'\nconst run = runProcessSync<string>\nrun(a)",
      1,
      ['runProcessSync']
    ],
    // Binding an alias is setup; each call through it is a use, so an alias refactor keeps the count.
    [
      "import { execSync } from 'child_process'\nconst run = execSync\nrun('a')\nrun('b')",
      2,
      ['execSync']
    ],
    ["import { execSync } from 'child_process'\nexport const run = execSync", 1, ['execSync']],
    ["import { execSync } from 'child_process'\nconst out = execSync('a')", 1, ['execSync']]
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
    "import { gitExecFileAsync } from './git/command-runner/git-exec-file'\ngitExecFileAsync(['status'])"
  ])('ignores %s', (source) => {
    expect(uses(source)).toEqual({ count: 0, symbols: [] })
  })

  it.each(['import {', 'const broken = ;'])(
    'fails closed on source it cannot parse: %s',
    (source) => {
      expect(() => uses(source)).toThrow('Cannot parse src/main/consumer.ts')
    }
  )

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
      "import { restrictWindowsPathSync } from '../shared/secure-storage/secure-path-windows-acl'\nrestrictWindowsPathSync(a, b)\n"
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
