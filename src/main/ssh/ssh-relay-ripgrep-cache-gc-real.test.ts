import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: execMock }))
import { gcRemoteRipgrepCache } from './ssh-relay-ripgrep-cache-gc'
import { recordRemoteRipgrepReference } from './ssh-relay-ripgrep-install'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'

const platform = process.platform === 'win32' ? 'win32-x64' : 'linux-x64'
const host = getRemoteHostPlatform(platform)
const FIRST = `1111111111111111-${platform}`
const SECOND = `2222222222222222-${platform}`
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only execCommand touches the connection, and it is replaced with a local shell.
const conn = {} as SshConnection

function runShell(command: string): string {
  return process.platform === 'win32'
    ? execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', decodeRemotePowerShellScript(command)],
        { encoding: 'utf8', timeout: 15_000 }
      )
    : execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 15_000 })
}

describe('ripgrep cache shell transactions', () => {
  let home: string
  let root: string
  let cache: string
  let relay: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca rg gc '))
    root = join(home, '.orca-remote')
    cache = join(root, 'ripgrep')
    relay = join(root, 'relay-0.1.0+abc')
    mkdirSync(relay, { recursive: true })
    for (const entry of [FIRST, SECOND]) {
      mkdirSync(join(cache, entry), { recursive: true })
      writeFileSync(join(cache, entry, 'rg'), entry)
    }
    execMock
      .mockReset()
      .mockImplementation(async (_conn: unknown, command: string) => runShell(command))
  })

  afterEach(() => {
    chmodSync(root, 0o755)
    rmSync(home, { recursive: true, force: true })
  })

  it('keeps both binaries recorded in one relay directory and collects them after that directory goes', async () => {
    await recordRemoteRipgrepReference(conn, host, relay, FIRST)
    await recordRemoteRipgrepReference(conn, host, relay, SECOND)
    await gcRemoteRipgrepCache(conn, host, home)
    expect(readdirSync(cache).sort()).toEqual([FIRST, SECOND])
    rmSync(relay, { recursive: true })
    await gcRemoteRipgrepCache(conn, host, home)
    expect(readdirSync(cache)).toEqual([])
  })

  it('preserves a legacy reference beside newer per-entry markers', async () => {
    writeFileSync(join(relay, '.ripgrep-ref'), FIRST)
    await recordRemoteRipgrepReference(conn, host, relay, SECOND)
    await gcRemoteRipgrepCache(conn, host, home)
    expect(readdirSync(cache).sort()).toEqual([FIRST, SECOND])
  })

  it.each(['', ' \t\r\n'])(
    'blocks collection when a legacy marker is empty or whitespace: %j',
    async (contents) => {
      writeFileSync(join(relay, '.ripgrep-ref'), contents)
      await recordRemoteRipgrepReference(conn, host, relay, SECOND)
      await gcRemoteRipgrepCache(conn, host, home)
      expect(readdirSync(cache).sort()).toEqual([FIRST, SECOND])
    }
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'preserves binaries when the relay directory listing is unreadable',
    async () => {
      await recordRemoteRipgrepReference(conn, host, relay, FIRST)
      chmodSync(root, 0o111)
      await gcRemoteRipgrepCache(conn, host, home)
      expect(existsSync(join(cache, FIRST, 'rg'))).toBe(true)
      expect(existsSync(join(cache, SECOND, 'rg'))).toBe(true)
    }
  )

  it('keeps abandoned tombstones while their references are unknown, then collects unreferenced ones', async () => {
    const tombstone = `.rg-gc-${SECOND}.123.${Date.now() - 60 * 60_000}`
    mkdirSync(join(cache, tombstone))
    writeFileSync(join(cache, tombstone, 'rg'), SECOND)
    await gcRemoteRipgrepCache(conn, host, home)
    expect(existsSync(join(cache, tombstone, 'rg'))).toBe(true)
    await recordRemoteRipgrepReference(conn, host, relay, FIRST)
    await gcRemoteRipgrepCache(conn, host, home)
    expect(readdirSync(cache)).toEqual([FIRST])
  })

  it('restores an abandoned tombstone that a relay still references', async () => {
    await recordRemoteRipgrepReference(conn, host, relay, FIRST)
    await recordRemoteRipgrepReference(conn, host, relay, SECOND)
    const tombstone = `.rg-gc-${SECOND}.123.${Date.now() - 60 * 60_000}`
    renameSync(join(cache, SECOND), join(cache, tombstone))

    await gcRemoteRipgrepCache(conn, host, home)

    expect(readdirSync(cache).sort()).toEqual([FIRST, SECOND])
    expect(existsSync(join(cache, SECOND, 'rg'))).toBe(true)
  })

  it('does not nest a tombstone inside a directory recreated by a concurrent installer', async () => {
    await recordRemoteRipgrepReference(conn, host, relay, FIRST)
    let raced = false
    execMock.mockImplementation(async (_conn: unknown, command: string) => {
      const output = runShell(command)
      const script = process.platform === 'win32' ? decodeRemotePowerShellScript(command) : command
      if (
        !raced &&
        (script.startsWith('mv ') || script.includes('Move-Item')) &&
        script.includes(SECOND)
      ) {
        raced = true
        await recordRemoteRipgrepReference(conn, host, relay, SECOND)
        mkdirSync(join(cache, SECOND))
        writeFileSync(join(cache, SECOND, 'rg'), SECOND)
      }
      return output
    })
    await gcRemoteRipgrepCache(conn, host, home)
    expect(raced).toBe(true)
    expect(readdirSync(join(cache, SECOND))).toEqual(['rg'])
  })
})
