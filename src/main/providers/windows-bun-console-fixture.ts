import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnBunPty } from '../daemon/pty-subprocess/bun-pty-process'
import { readWindowsConsoleAttachedProcessIds } from './windows-console-attached-processes'

async function verify(): Promise<void> {
  assert.equal(process.platform, 'win32')
  assert(process.versions.bun)
  const proc = spawnBunPty({
    file: 'cmd.exe',
    args: ['/d', '/q'],
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
    cols: 80,
    rows: 24
  })
  const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()))
  try {
    await proc.waitForSpawn?.()
    const first = await readWindowsConsoleAttachedProcessIds(proc.pid)
    assert(first, 'console membership must be available')
    assert(first.has(proc.pid), 'console membership must contain its actual PTY root')
    proc.write('ping -n 30 127.0.0.1\r')
    const deadline = Date.now() + 5_000
    let members = first
    while (members.size <= first.size && Date.now() < deadline) {
      await delay(100)
      const observed = await readWindowsConsoleAttachedProcessIds(proc.pid)
      assert(observed, 'console membership became unavailable')
      members = observed
    }
    assert(members.size > first.size, 'running console child must be visible')
    assert.equal(await readWindowsConsoleAttachedProcessIds(0xffff_ffff), null)
    console.log(
      JSON.stringify({ runtime: process.versions.bun, first: [...first], running: [...members] })
    )
  } finally {
    proc.kill()
    await Promise.race([
      exited,
      delay(5_000, undefined, { ref: false }).then(() => {
        throw new Error('PTY did not exit')
      })
    ])
  }
}

void verify().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
