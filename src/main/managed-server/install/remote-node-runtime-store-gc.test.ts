import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
import {
  gcRemoteNodeRuntimeStore,
  parseSweptRuntimeStages,
  sweepStaleRuntimeStagesCommand
} from './remote-node-runtime-store-gc'
import { RUNTIME_STORE_LOCK_NAME } from './remote-node-runtime-store-lock'
import { RUNTIME_REF_NODE_PREFIX } from './remote-node-runtime-store-inventory'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { unusedSshConnection } from '../../ssh/unused-host-transport.test-fixture'

const conn = unusedSshConnection()
const host = getRemoteHostPlatform('linux-x64')
const mockExec = vi.mocked(execCommand)
const sha = (c: string): string => c.repeat(64)

const posixOnly = process.platform === 'win32' ? describe.skip : describe

posixOnly('gcRemoteNodeRuntimeStore (real shell)', () => {
  let home: string
  let root: string
  let running: ChildProcess | null = null

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'runtime-store-'))
    root = join(home, '.orca-remote')
    mkdirSync(join(root, 'runtimes'), { recursive: true })
    mockExec.mockReset()
    mockExec.mockImplementation(async (_conn, command) =>
      execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    )
  })
  afterEach(() => {
    running?.kill('SIGKILL')
    running = null
    rmSync(home, { recursive: true, force: true })
  })

  function runtime(c: string, verified = true): string {
    const dir = join(root, 'runtimes', `node-${sha(c)}`)
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'node'), '#!/bin/sh\nsleep 30\n')
    chmodSync(join(dir, 'bin', 'node'), 0o755)
    if (verified) {
      writeFileSync(join(dir, '.verified'), '')
      const at = c === 'b' ? 2_000_000 : 1_000_000
      utimesSync(join(dir, '.verified'), at, at)
    }
    return dir
  }

  function versionDir(name: string): string {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('removes only unreferenced, unpinned, idle, verified runtimes', async () => {
    runtime('a') // current pin
    runtime('c') // referenced by an orcad slot marker
    runtime('d') // referenced by a relay ref file
    runtime('e') // unreferenced: collected
    const running_ = runtime('f') // executing
    runtime('9', false) // mid-promotion
    runtime('b') // newest other verified: the previous pin
    writeFileSync(join(versionDir('orcad-0.1.0+aaa'), '.runtime-node'), `${sha('c')}\n`)
    writeFileSync(join(versionDir('relay-0.1.0+aaa'), `${RUNTIME_REF_NODE_PREFIX}${sha('d')}`), '')
    running = spawn(join(running_, 'bin', 'node'), [], { stdio: 'ignore' })
    await once(running, 'spawn')

    const result = await gcRemoteNodeRuntimeStore(conn, host, home, { currentPins: [sha('a')] })

    expect(result).toMatchObject({
      state: 'collected',
      removed: [`node-${sha('e')}`],
      legacyDirs: expect.arrayContaining(['orcad-0.1.0+aaa', 'relay-0.1.0+aaa'])
    })
    for (const kept of ['a', 'b', 'c', 'd', 'f', '9']) {
      expect(existsSync(join(root, 'runtimes', `node-${sha(kept)}`))).toBe(true)
    }
    expect(existsSync(join(root, 'runtimes', `node-${sha('e')}`))).toBe(false)
    // Legacy version directories are diagnostics only; runtime GC must preserve them.
    expect(existsSync(join(root, 'orcad-0.1.0+aaa'))).toBe(true)
    expect(existsSync(join(root, 'relay-0.1.0+aaa'))).toBe(true)
  })

  it('holds a runtime a process runs through another spelling of a symlinked home', async () => {
    runtime('a')
    runtime('b')
    const held = runtime('e')
    const alias = mkdtempSync(join(tmpdir(), 'runtime-store-alias-'))
    rmSync(alias, { recursive: true })
    symlinkSync(home, alias)
    try {
      running = spawn(join(held, 'bin', 'node'), [], { stdio: 'ignore' })
      await once(running, 'spawn')

      const result = await gcRemoteNodeRuntimeStore(conn, host, alias, { currentPins: [sha('a')] })

      expect(result).toMatchObject({ state: 'collected', removed: [] })
      expect(existsSync(join(held, 'bin', 'node'))).toBe(true)
    } finally {
      rmSync(alias, { force: true })
    }
  })

  it('keeps every runtime when a reference marker cannot be attributed', async () => {
    runtime('a')
    runtime('b')
    runtime('e')
    writeFileSync(join(versionDir('server-0.2.0+ccc'), '.runtime-node'), 'not-a-sha\n')

    const result = await gcRemoteNodeRuntimeStore(conn, host, home, { currentPins: [sha('a')] })

    expect(result.state).toBe('skipped')
    expect(existsSync(join(root, 'runtimes', `node-${sha('e')}`))).toBe(true)
  })

  it('restores a runtime that gained a reference after the rename', async () => {
    runtime('a')
    runtime('b')
    runtime('e')
    let inventories = 0
    mockExec.mockImplementation(async (_conn, command) => {
      if (command.includes('__ORCA_RUNTIME_STORE__OK') && ++inventories === 2) {
        writeFileSync(join(versionDir('orcad-0.3.0+ddd'), '.runtime-node'), `${sha('e')}\n`)
      }
      return execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    })

    const result = await gcRemoteNodeRuntimeStore(conn, host, home, { currentPins: [sha('a')] })

    expect(result).toMatchObject({ state: 'collected', removed: [] })
    expect(existsSync(join(root, 'runtimes', `node-${sha('e')}`, 'bin', 'node'))).toBe(true)
  })

  it('skips the pass while an installer holds the store lock', async () => {
    runtime('a')
    runtime('b')
    runtime('e')
    mkdirSync(join(root, 'runtimes', RUNTIME_STORE_LOCK_NAME))

    const result = await gcRemoteNodeRuntimeStore(conn, host, home, { currentPins: [sha('a')] })

    expect(result.state).toBe('skipped')
    expect(existsSync(join(root, 'runtimes', `node-${sha('e')}`))).toBe(true)
    expect(existsSync(join(root, 'runtimes', RUNTIME_STORE_LOCK_NAME))).toBe(true)
  })

  it('keeps the store lock when the pass ends in an unconfirmed termination', async () => {
    runtime('a')
    const lost = Object.assign(new Error('lost'), { sshChannelCloseConfirmed: false })
    mockExec.mockImplementation(async (_conn, command) => {
      if (command.includes('__ORCA_RUNTIME_STORE__OK')) {
        throw lost
      }
      return execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    })

    await expect(
      gcRemoteNodeRuntimeStore(conn, host, home, { currentPins: [sha('a')] })
    ).rejects.toBe(lost)
    expect(existsSync(join(root, 'runtimes', RUNTIME_STORE_LOCK_NAME))).toBe(true)
  })

  it('sweeps only upload stages nothing has written to within the stale rule', async () => {
    runtime('a')
    const old = Date.now() / 1000 - 21 * 60
    const stage = (name: string, fileAge: number, dirAge: number): string => {
      const dir = join(root, 'runtimes', name)
      mkdirSync(dir)
      writeFileSync(join(dir, 'node.tar.gz'), 'x')
      utimesSync(join(dir, 'node.tar.gz'), fileAge, fileAge)
      utimesSync(dir, dirAge, dirAge)
      return dir
    }
    const now = Date.now() / 1000
    const abandoned = stage(`.stage-node-${sha('c')}-1`, old, old)
    const uploading = stage(`.stage-node-${sha('c')}-2`, now, old)
    const fresh = stage(`.stage-node-${sha('c')}-3`, now, now)

    const result = await gcRemoteNodeRuntimeStore(conn, host, home, { currentPins: [sha('a')] })

    expect(result).toMatchObject({ sweptStages: [`.stage-node-${sha('c')}-1`] })
    expect(existsSync(abandoned)).toBe(false)
    expect(existsSync(uploading)).toBe(true)
    expect(existsSync(fresh)).toBe(true)
  })

  it('keeps a stage when find cannot answer', () => {
    const dir = join(root, 'runtimes', '.stage-node-x-1')
    mkdirSync(dir)
    const old = Date.now() / 1000 - 21 * 60
    utimesSync(dir, old, old)
    const out = execFileSync(
      '/bin/sh',
      ['-c', `find() { return 1; }\n${sweepStaleRuntimeStagesCommand(join(root, 'runtimes'))}`],
      { encoding: 'utf8' }
    )
    expect(parseSweptRuntimeStages(out)).toEqual([])
    expect(existsSync(dir)).toBe(true)
  })
})
