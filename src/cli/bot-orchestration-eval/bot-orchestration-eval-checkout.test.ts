import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  checkoutChanged,
  checkoutSnapshot,
  cloneCheckout,
  installGitPushGuard
} from './bot-orchestration-eval-checkout'

async function run(program: string, args: string[], cwd: string) {
  return runProcess({ program, args, cwd, stdio: ['ignore', 'pipe', 'pipe'], timeoutMs: 30_000 })
}

describe('bot orchestration eval checkouts', () => {
  let root: string
  let source: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-eval-checkout-test-'))
    source = join(root, 'source')
    await mkdir(source)
    await run('git', ['init', '--quiet'], source)
    await writeFile(join(source, 'README.md'), '# orca\n')
    await run('git', ['add', '.'], source)
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], source)
    await run('git', ['remote', 'add', 'origin', 'https://example.invalid/orca.git'], source)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('clones without any remote', async () => {
    const clone = join(root, 'clone')
    await cloneCheckout(source, clone)
    expect((await run('git', ['remote'], clone)).stdout.trim()).toBe('')
  })

  it('sees a commit, a new file and a stash as changes', async () => {
    const clone = join(root, 'clone')
    await cloneCheckout(source, clone)
    const before = await checkoutSnapshot(clone)
    expect(await checkoutChanged(clone, before)).toBe(false)
    await writeFile(join(clone, 'notes.txt'), 'x')
    expect(await checkoutChanged(clone, before)).toBe(true)
    await run('git', ['add', '.'], clone)
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], clone)
    expect(await checkoutChanged(clone, before)).toBe(true)
  })

  it('counts a checkout git cannot read as changed', async () => {
    const clone = join(root, 'clone')
    await cloneCheckout(source, clone)
    const before = await checkoutSnapshot(clone)
    await rm(join(clone, '.git'), { recursive: true, force: true })
    expect(await checkoutChanged(clone, before)).toBe(true)
  })

  // The guard is a POSIX shell script, like the eval's other shims; the eval requires zsh.
  it.skipIf(process.platform === 'win32')('refuses git push behind global options', async () => {
    await mkdir(join(root, 'bin'))
    await installGitPushGuard(root)
    const guarded = join(root, 'bin', 'git')
    const pushed = await run(guarded, ['-C', source, 'push', 'origin', 'HEAD'], root)
    expect(pushed.code).not.toBe(0)
    expect(pushed.stderr).toContain('git push is not available here.')
    expect((await run(guarded, ['-C', source, 'status', '--short'], root)).code).toBe(0)
  })
})
