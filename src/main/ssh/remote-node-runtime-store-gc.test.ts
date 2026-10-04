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
import type * as DeployHelpers from './ssh-relay-deploy-helpers'

vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployHelpers>()),
  execCommand: vi.fn()
}))

import type { SshConnection } from './ssh-connection'
import {
  gcRemoteNodeRuntimeStore,
  parseSweptRuntimeStages,
  planRuntimeStoreGc,
  sweepStaleRuntimeStagesCommand
} from './remote-node-runtime-store-gc'
import { RUNTIME_STORE_LOCK_NAME } from './remote-node-runtime-store-lock'
import {
  parseRuntimeStoreInventory,
  RUNTIME_REF_NODE_PREFIX,
  runtimeStoreInventoryCommand,
  type RuntimeStoreInventory
} from './remote-node-runtime-store-inventory'
import { execCommand } from './ssh-relay-deploy-helpers'
import { getRemoteHostPlatform } from './ssh-remote-platform'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all connection access is replaced by execCommand's mock.
const conn = {} as SshConnection
const host = getRemoteHostPlatform('linux-x64')
const mockExec = vi.mocked(execCommand)
const sha = (c: string): string => c.repeat(64)

function inventory(overrides: Partial<RuntimeStoreInventory> = {}): RuntimeStoreInventory {
  return {
    entries: [],
    verifiedNewestFirst: [],
    referenced: new Set(),
    held: new Set(),
    processCheckRan: true,
    dirNames: [],
    ...overrides
  }
}

describe('planRuntimeStoreGc', () => {
  const all = ['a', 'b', 'c', 'd'].map((c) => `node-${sha(c)}`)

  it('keeps the current pin and the newest other verified runtime', () => {
    const plan = planRuntimeStoreGc(
      inventory({ entries: all, verifiedNewestFirst: [all[0], all[1], all[2], all[3]] }),
      [sha('b')]
    )
    expect(plan.remove).toEqual([all[2], all[3]])
    expect(plan.kept).toEqual([all[0], all[1]])
  })

  it('keeps a compat pin beside the default one and still keeps the previous runtime', () => {
    // b is the default pin, c the rung B compat pin; a is the newest other (previous) runtime.
    const plan = planRuntimeStoreGc(
      inventory({ entries: all, verifiedNewestFirst: [all[0], all[1], all[2], all[3]] }),
      [sha('b'), sha('c')]
    )
    expect(plan.remove).toEqual([all[3]])
    expect(plan.kept).toEqual([all[0], all[1], all[2]])
  })

  it('keeps referenced, process-held and unverified runtimes', () => {
    const plan = planRuntimeStoreGc(
      inventory({
        entries: all,
        verifiedNewestFirst: [all[0], all[1], all[2]],
        referenced: new Set([sha('b')]),
        held: new Set([sha('c')])
      }),
      [sha('a')]
    )
    expect(plan.remove).toEqual([])
  })

  it('keeps everything when no process check could run', () => {
    const plan = planRuntimeStoreGc(
      inventory({ entries: all, verifiedNewestFirst: all, processCheckRan: false }),
      [sha('a')]
    )
    expect(plan.remove).toEqual([])
  })

  it('purges only abandoned tombstones of unwanted runtimes', () => {
    const now = 10 * 60 * 60_000
    const old = `.gc-tombstone-node-${sha('c')}.7.${now - 31 * 60_000}`
    const fresh = `.gc-tombstone-node-${sha('d')}.7.${now - 60_000}`
    const referenced = `.gc-tombstone-node-${sha('e')}.7.${now - 31 * 60_000}`
    const plan = planRuntimeStoreGc(
      inventory({ entries: [old, fresh, referenced], referenced: new Set([sha('e')]) }),
      [sha('a')],
      now
    )
    expect(plan.purgeTombstones).toEqual([old])
  })
})

describe('parseRuntimeStoreInventory', () => {
  it('rejects a partial listing, a reference error, and an unattributable reference', () => {
    expect(parseRuntimeStoreInventory('ENTRY node-x')).toBeNull()
    expect(
      parseRuntimeStoreInventory('__ORCA_RUNTIME_STORE__REFS_ERR\n__ORCA_RUNTIME_STORE__OK')
    ).toBeNull()
    expect(parseRuntimeStoreInventory('REF garbage\n__ORCA_RUNTIME_STORE__OK')).toBeNull()
  })

  it('attributes process holds by runtime path, including renamed tombstones', () => {
    const parsed = parseRuntimeStoreInventory(
      [
        'PROCESS_CHECK ps',
        `HOLD /h/.orca-remote/runtimes/node-${sha('a')}/bin/node server.js`,
        `HOLD /h/.orca-remote/runtimes/.gc-tombstone-node-${sha('b')}.1.2/bin/node`,
        'HOLD grep -F -- /h/.orca-remote/runtimes/',
        '__ORCA_RUNTIME_STORE__OK'
      ].join('\n')
    )
    expect(parsed?.held).toEqual(new Set([sha('a'), sha('b')]))
  })
})

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

  // `b` is always verified last, so it is the previous pin the store keeps.
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
    // D10 two-step: legacy dirs are reported, never deleted by this pass.
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

  it('recovers a lock past the 20-minute stale rule and releases it after the pass', async () => {
    runtime('a')
    runtime('b')
    runtime('e')
    const lock = join(root, 'runtimes', RUNTIME_STORE_LOCK_NAME)
    mkdirSync(lock)
    const old = Date.now() / 1000 - 21 * 60
    utimesSync(lock, old, old)

    const result = await gcRemoteNodeRuntimeStore(conn, host, home, { currentPins: [sha('a')] })

    expect(result).toMatchObject({ state: 'collected', removed: [`node-${sha('e')}`] })
    expect(existsSync(lock)).toBe(false)
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

  it('is inert when the store does not exist', async () => {
    rmSync(join(root, 'runtimes'), { recursive: true })
    const out = execFileSync('/bin/sh', ['-c', runtimeStoreInventoryCommand(host, home)], {
      encoding: 'utf8'
    })
    expect(parseRuntimeStoreInventory(out)?.entries).toEqual([])
  })
})

describe('gcRemoteNodeRuntimeStore termination', () => {
  beforeEach(() => {
    mockExec.mockReset()
  })

  it('rethrows an unconfirmed inventory termination', async () => {
    const error = Object.assign(new Error('SSH command timed out'), {
      sshChannelCloseConfirmed: false
    })
    mockExec.mockRejectedValueOnce(error)
    await expect(
      gcRemoteNodeRuntimeStore(conn, host, '/home/u', { currentPins: [sha('a')] })
    ).rejects.toBe(error)
  })
})
