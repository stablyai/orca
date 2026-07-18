import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  configureNativeGitBlobReads,
  MAX_GIT_SHOW_BYTES,
  readGitBlobRaw,
  resetNativeGitBlobReadStateForTests,
  type BlobReadRequest,
  type RawBlobOutcome
} from './blob-reader'

const artifact = path.join(process.cwd(), 'native', 'git-native', '.build', 'git-native.node')

// Why: when CI sets ORCA_REQUIRE_GIT_NATIVE=1 (after building the addon), a
// missing artifact must FAIL loudly rather than silently skip — a skipped
// parity suite would vanish the rollout gate if the build step drifts. Locally
// (unset) the suite still skips when the addon genuinely isn't built.
const requireNative = process.env.ORCA_REQUIRE_GIT_NATIVE === '1'

// Why: a module-level path that is never created, so `GIT_CONFIG_GLOBAL` points
// at a missing file (git reads it as empty config). Mirrors the hermetic Rust
// fixtures (native/git-native/tests/blob_read.rs) — a contributor's global
// config (commit.gpgsign, core.hooksPath, init.templateDir) must not leak in
// and skew the fixtures.
const NONEXISTENT_GITCONFIG = path.join(tmpdir(), 'orca-parity-nonexistent-gitconfig')

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: NONEXISTENT_GITCONFIG,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  })
}

async function readBoth(
  request: BlobReadRequest
): Promise<{ native: RawBlobOutcome; cli: RawBlobOutcome }> {
  resetNativeGitBlobReadStateForTests()
  configureNativeGitBlobReads(() => 'on')
  const native = await readGitBlobRaw(request)
  resetNativeGitBlobReadStateForTests()
  configureNativeGitBlobReads(() => 'off')
  const cli = await readGitBlobRaw(request)
  return { native, cli }
}

function expectParity(pair: { native: RawBlobOutcome; cli: RawBlobOutcome }): void {
  expect(pair.native.found).toBe(pair.cli.found)
  expect(pair.native.tooLarge).toBe(pair.cli.tooLarge)
  const nativeBytes = pair.native.bytes
  const cliBytes = pair.cli.bytes
  // Why: a base64 assert on a multi-MB blob dumps two unreadable strings on
  // failure. When the bytes differ, surface length + first-diff offset/byte
  // first so a boundary or empty-file regression is legible; the base64
  // equality below stays the rigorous check for the small cases.
  if (nativeBytes && cliBytes && !nativeBytes.equals(cliBytes)) {
    const minLen = Math.min(nativeBytes.length, cliBytes.length)
    let firstDiffAt = minLen // one buffer is a prefix of the other
    for (let i = 0; i < minLen; i += 1) {
      if (nativeBytes[i] !== cliBytes[i]) {
        firstDiffAt = i
        break
      }
    }
    expect({
      nativeLen: nativeBytes.length,
      cliLen: cliBytes.length,
      firstDiffAt,
      nativeByteHex: nativeBytes[firstDiffAt]?.toString(16),
      cliByteHex: cliBytes[firstDiffAt]?.toString(16)
    }).toEqual({
      nativeLen: cliBytes.length,
      cliLen: cliBytes.length,
      firstDiffAt: -1,
      nativeByteHex: undefined,
      cliByteHex: undefined
    })
  }
  expect(nativeBytes?.toString('base64')).toBe(cliBytes?.toString('base64'))
}

// Why: outside the skipIf so it runs even when the suite skips — turns a
// missing addon under the CI gate into a hard failure instead of silent green.
it('git-native addon must be built when ORCA_REQUIRE_GIT_NATIVE=1', () => {
  if (requireNative && !existsSync(artifact)) {
    throw new Error(`parity gate: git-native addon missing at ${artifact}`)
  }
})

describe.skipIf(!existsSync(artifact) && !requireNative)('native/CLI blob-read parity', () => {
  // Gitlink and sparse-dir entries are intentionally excluded: native returns
  // NotFound while git show pretty-prints a locally-resolvable gitlink commit
  // (documented divergence, unreachable in production — submodules are routed
  // away before blob reads).
  let root: string
  let repo: string

  beforeAll(() => {
    process.env.ORCA_GIT_NATIVE_PATH = artifact
    root = mkdtempSync(path.join(tmpdir(), 'orca-git-native-parity-'))
    repo = path.join(root, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '--quiet', '-b', 'main'])

    writeFileSync(path.join(repo, 'plain.txt'), 'hello world\n')
    writeFileSync(path.join(repo, 'crlf.txt'), 'line1\r\nline2\r\n')
    writeFileSync(path.join(repo, '.gitattributes'), '*.txt text=auto\n')
    mkdirSync(path.join(repo, 'nested', 'deep'), { recursive: true })
    writeFileSync(path.join(repo, 'nested', 'deep', 'file with spaces é.txt'), 'unicode path\n')
    writeFileSync(
      path.join(repo, 'binary.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01])
    )
    // Why: 0-byte blob guards the native→raw adapter's `!result.data` branch —
    // an empty read must stay found:true with empty bytes, not fall through to
    // not-found.
    writeFileSync(path.join(repo, 'empty.txt'), '')
    writeFileSync(path.join(repo, 'huge.bin'), Buffer.alloc(11 * 1024 * 1024, 7))
    // Why: pin the tooLarge boundary at the exact edge — native `size > max` and
    // Node maxBuffer must agree that at-limit is served and +1 is tooLarge.
    writeFileSync(path.join(repo, 'exact-limit.bin'), Buffer.alloc(MAX_GIT_SHOW_BYTES, 7))
    writeFileSync(path.join(repo, 'over-limit.bin'), Buffer.alloc(MAX_GIT_SHOW_BYTES + 1, 7))
    if (process.platform !== 'win32') {
      symlinkSync('plain.txt', path.join(repo, 'link'))
    }
    git(repo, ['add', '-A'])
    git(repo, ['commit', '--quiet', '-m', 'base'])
    // Why: gc packs the loose objects so reads exercise the packed-object path
    // too (dual loose/packed coverage) — don't drop this in a refactor.
    git(repo, ['gc', '--quiet'])
    writeFileSync(path.join(repo, 'plain.txt'), 'staged content\n')
    git(repo, ['add', 'plain.txt'])
    git(repo, ['worktree', 'add', '--quiet', path.join(root, 'wt'), '-b', 'wt-branch'])
    writeFileSync(path.join(root, 'wt', 'plain.txt'), 'wt staged\n')
    git(path.join(root, 'wt'), ['add', 'plain.txt'])
  })

  afterAll(async () => {
    delete process.env.ORCA_GIT_NATIVE_PATH
    // Why: 'on' mode fires a fire-and-forget CLI verify for sampled reads; let
    // any in-flight verify settle against the still-existing repo before rmSync,
    // so a verify racing teardown can't `git show` a deleted repo and log a
    // false 'presence' divergence after the suite is already green.
    await new Promise((resolve) => setTimeout(resolve, 50))
    rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => resetNativeGitBlobReadStateForTests())

  const revCases: [string, string][] = [
    ['plain text at HEAD', 'plain.txt'],
    ['crlf file (raw object bytes, no smudge)', 'crlf.txt'],
    ['nested unicode path', 'nested/deep/file with spaces é.txt'],
    ['binary blob', 'binary.png'],
    ['empty committed file (0 bytes)', 'empty.txt'],
    ['missing path', 'does-not-exist.txt']
  ]

  for (const [label, file] of revCases) {
    it(`rev read parity: ${label}`, async () => {
      expectParity(await readBoth({ kind: 'rev', worktreePath: repo, rev: 'HEAD', gitPath: file }))
    })
  }

  it('rev read parity: symlink entry', async () => {
    if (process.platform === 'win32') {
      return
    }
    expectParity(await readBoth({ kind: 'rev', worktreePath: repo, rev: 'HEAD', gitPath: 'link' }))
  })

  it('rev read parity: over-limit blob is tooLarge on both paths', async () => {
    const pair = await readBoth({
      kind: 'rev',
      worktreePath: repo,
      rev: 'HEAD',
      gitPath: 'huge.bin'
    })
    expectParity(pair)
    expect(pair.native.tooLarge).toBe(true)
  })

  it('rev read parity: blob exactly at the size limit is served on both paths', async () => {
    const pair = await readBoth({
      kind: 'rev',
      worktreePath: repo,
      rev: 'HEAD',
      gitPath: 'exact-limit.bin'
    })
    expectParity(pair)
    expect(pair.native.found).toBe(true)
    expect(pair.native.tooLarge).toBe(false)
  })

  it('rev read parity: blob one byte over the limit is tooLarge on both paths', async () => {
    const pair = await readBoth({
      kind: 'rev',
      worktreePath: repo,
      rev: 'HEAD',
      gitPath: 'over-limit.bin'
    })
    expectParity(pair)
    expect(pair.native.tooLarge).toBe(true)
  })

  it('rev read parity: explicit commit oid', async () => {
    const oid = git(repo, ['rev-parse', 'HEAD']).trim()
    expectParity(
      await readBoth({ kind: 'rev', worktreePath: repo, rev: oid, gitPath: 'plain.txt' })
    )
  })

  it('rev read parity: bad rev', async () => {
    expectParity(
      await readBoth({ kind: 'rev', worktreePath: repo, rev: 'no-such-ref', gitPath: 'plain.txt' })
    )
  })

  it('index read parity: staged content differs from HEAD', async () => {
    const pair = await readBoth({ kind: 'index', worktreePath: repo, gitPath: 'plain.txt' })
    expectParity(pair)
    expect(pair.native.bytes?.toString()).toBe('staged content\n')
  })

  it('index read parity in a linked worktree (private index)', async () => {
    const pair = await readBoth({
      kind: 'index',
      worktreePath: path.join(root, 'wt'),
      gitPath: 'plain.txt'
    })
    expectParity(pair)
    expect(pair.native.bytes?.toString()).toBe('wt staged\n')
  })

  it('index read parity: missing path', async () => {
    expectParity(await readBoth({ kind: 'index', worktreePath: repo, gitPath: 'nope.txt' }))
  })

  it('index read parity: empty staged blob (0 bytes)', async () => {
    const pair = await readBoth({ kind: 'index', worktreePath: repo, gitPath: 'empty.txt' })
    expectParity(pair)
    expect(pair.native.found).toBe(true)
    expect(pair.native.bytes?.length).toBe(0)
  })

  it('index read parity: unmerged path (no stage-0 entry)', async () => {
    const conflictRepo = path.join(root, 'conflict')
    mkdirSync(conflictRepo)
    git(conflictRepo, ['init', '--quiet', '-b', 'main'])
    writeFileSync(path.join(conflictRepo, 'c.txt'), 'base\n')
    git(conflictRepo, ['add', '-A'])
    git(conflictRepo, ['commit', '--quiet', '-m', 'base'])
    git(conflictRepo, ['checkout', '--quiet', '-b', 'side'])
    writeFileSync(path.join(conflictRepo, 'c.txt'), 'side\n')
    git(conflictRepo, ['commit', '--quiet', '-am', 'side'])
    git(conflictRepo, ['checkout', '--quiet', 'main'])
    writeFileSync(path.join(conflictRepo, 'c.txt'), 'main\n')
    git(conflictRepo, ['commit', '--quiet', '-am', 'main'])
    try {
      git(conflictRepo, ['merge', 'side'])
    } catch {
      // conflict expected
    }
    expectParity(await readBoth({ kind: 'index', worktreePath: conflictRepo, gitPath: 'c.txt' }))
  })
})
