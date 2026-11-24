import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runWorktreeProviderCommand } from './provider-process-runner'

const STUB = `
const args = process.argv.slice(2)
if (args[0] === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, 5000))
}
if (args[0] === 'fail') {
  console.error('slot is dirty')
  process.exit(75)
}
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }))
`

describe('worktree provider process runner', () => {
  let dir = ''
  let stub = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-provider-runner-'))
    stub = join(dir, 'provider.mjs')
    writeFileSync(stub, STUB, 'utf8')
    chmodSync(stub, 0o755)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes argv without a shell interpreting it', async () => {
    const sentinel = join(dir, 'sentinel')
    const result = await runWorktreeProviderCommand({
      argv: [process.execPath, stub, `$(touch ${sentinel})`, '--repo', '/repo'],
      cwd: dir,
      timeoutMs: 5_000,
      provider: 'wtp',
      phase: 'claim'
    })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).argv).toEqual([`$(touch ${sentinel})`, '--repo', '/repo'])
    expect(existsSync(sentinel)).toBe(false)
  })

  it('resolves a nonzero exit with stderr so release refusals are normal outcomes', async () => {
    const result = await runWorktreeProviderCommand({
      argv: [process.execPath, stub, 'fail'],
      cwd: dir,
      timeoutMs: 5_000,
      provider: 'wtp',
      phase: 'release'
    })
    expect(result.code).toBe(75)
    expect(result.stderr).toContain('slot is dirty')
  })

  it('times out a hung provider command', async () => {
    const result = await runWorktreeProviderCommand({
      argv: [process.execPath, stub, 'sleep'],
      cwd: dir,
      timeoutMs: 100,
      provider: 'wtp',
      phase: 'claim'
    })
    expect(result.timedOut).toBe(true)
  })
})
