import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookFlagTable from './codex-hook-flag-table'

const mocks = vi.hoisted(() => {
  const state: { mainPath: string; afterPrune: (() => void) | null; tableCreations: number } = {
    mainPath: '',
    afterPrune: null,
    tableCreations: 0
  }
  return { runProcess: vi.fn(), runCodexAppServerSession: vi.fn(), state }
})

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: mocks.runProcess }))
vi.mock('./codex-app-server-session', () => ({
  runCodexAppServerSession: mocks.runCodexAppServerSession
}))
vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: () => mocks.state.mainPath,
  withCliRuntimeOnPath: (_path: string, env: NodeJS.ProcessEnv) => env
}))
// Why: lets a test land a call at a chosen microtask after a run's last step.
vi.mock('./codex-hook-flag-table', async (importOriginal) => {
  const table = await importOriginal<typeof CodexHookFlagTable>()
  return {
    ...table,
    createCodexHookFlagTable: (...args: Parameters<typeof table.createCodexHookFlagTable>) => {
      mocks.state.tableCreations += 1
      table.createCodexHookFlagTable(...args)
    },
    pruneCodexHookFlagEntries: (...args: Parameters<typeof table.pruneCodexHookFlagEntries>) => {
      table.pruneCodexHookFlagEntries(...args)
      mocks.state.afterPrune?.()
    }
  }
})

import {
  _internals,
  getKnownCodexHookFlag,
  learnCodexHookFlagVersion,
  scheduleCodexHookFlagSync,
  startCodexHookFlagSync,
  syncCodexHookFlags,
  syncCodexHookFlagsWithin
} from './codex-hook-flag-sync'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getManagedCommand,
  getManagedScriptPath
} from './codex-hook-definition'
import {
  getCodexHookFlagTablePath,
  publishCodexHookFlagEntry,
  readCodexHookFlagEntry
} from './codex-hook-flag-table'

// Why a fake watch: these tests pin what the code does with an event, not when an OS delivers it.
class FakeWatcher extends EventEmitter {
  closed = false
  close(): void {
    this.closed = true
  }
  unref(): this {
    return this
  }
}

const canDenyWrites = process.platform !== 'win32' && process.getuid?.() !== 0
const versions = new Map<string, string | null>()
// Why: the 8.3 lookup's answer, for the Windows cases; null is a failed lookup.
let shortPath: () => string | null = () => null
let listedCommand: () => string = () => getManagedCommand(getManagedScriptPath())

function listingFor(flag: string): unknown {
  const approved = /state\s*=/.test(flag)
  return {
    data: [
      {
        hooks: CODEX_EVENTS.map((eventName) => {
          const label = CODEX_EVENT_LABEL[eventName]
          return {
            key: `/<session-flags>/config.toml:${label}:0:0`,
            command: listedCommand(),
            currentHash: `sha256:${label}`,
            trustStatus: approved ? 'trusted' : 'untrusted',
            source: 'sessionFlags',
            enabled: true
          }
        })
      }
    ]
  }
}

function versionCalls(): string[] {
  return mocks.runProcess.mock.calls
    .filter(([options]) => options.args[0] === '--version')
    .map(([options]) => options.program)
}

describe('syncCodexHookFlags', () => {
  let root: string
  let enabled: boolean
  let watchers: { path: string; watcher: FakeWatcher; fire: () => void }[]
  let stop: () => void = () => {}

  function writeBinary(path: string, content = 'codex'): string {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
    return path
  }

  function fakeWatch(path = '', onChange: () => void = () => {}): FSWatcher {
    const watcher = new FakeWatcher()
    watchers.push({ path, watcher, fire: onChange })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test calls only on/close/unref, which FakeWatcher implements.
    return watcher as unknown as FSWatcher
  }

  function start(pathReady?: Promise<unknown>): Promise<void> {
    stop = startCodexHookFlagSync({
      isEnabled: () => enabled,
      pathReady,
      watch: (path, onChange) => fakeWatch(path, onChange)
    })
    return syncCodexHookFlagsWithin(5_000)
  }

  const table = () => getCodexHookFlagTablePath()
  const entryFor = (version: string) => readCodexHookFlagEntry(version)
  const openWatches = (path: string) =>
    watchers.filter((watch) => watch.path === path && !watch.watcher.closed)
  // Why: a request is served only for a codex in a folder on main's own PATH.
  const putOnPath = (...folders: string[]) => vi.stubEnv('PATH', folders.join(delimiter))

  beforeEach(() => {
    // Why real: watches name folders as resolved, and macOS's temp folder sits behind /var.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-codex-hook-flag-sync-')))
    vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
    // Why: the sync writes the hook script under ~/.orca.
    vi.stubEnv('HOME', join(root, 'home'))
    vi.stubEnv('USERPROFILE', join(root, 'home'))
    mkdirSync(join(root, 'user-data'))
    _internals.resetForTesting()
    enabled = true
    watchers = []
    versions.clear()
    mocks.state.mainPath = writeBinary(join(root, 'bin', 'codex'))
    versions.set(mocks.state.mainPath, 'codex-cli 0.159.2')
    mocks.runProcess.mockReset()
    shortPath = () => null
    listedCommand = () => getManagedCommand(getManagedScriptPath())
    mocks.state.afterPrune = null
    mocks.runProcess.mockImplementation(async ({ program, args }) => {
      if (/cmd\.exe$/i.test(program)) {
        const path = shortPath()
        return path === null
          ? { code: 1, stdout: '', stderr: '', signal: null, timedOut: false }
          : { code: 0, stdout: `${path}\r\n`, stderr: '', signal: null, timedOut: false }
      }
      if (args[0] === '--help') {
        return { code: 0, stdout: 'Usage: codex [--no-daemon]', stderr: '', signal: null }
      }
      const version = versions.get(program) ?? null
      return version === 'timeout'
        ? { code: null, stdout: '', stderr: '', signal: 'SIGTERM', timedOut: true }
        : version === null
          ? { code: 1, stdout: '', stderr: 'boom', signal: null, timedOut: false }
          : { code: 0, stdout: `${version}\n`, stderr: '', signal: null, timedOut: false }
    })
    mocks.runCodexAppServerSession.mockReset()
    mocks.runCodexAppServerSession.mockImplementation(async (invocation, body) =>
      body({ request: async () => listingFor(invocation.args[1]) })
    )
  })

  afterEach(() => {
    stop()
    _internals.resetForTesting()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    const userTable = join(root, 'user-data', 'codex-hook-flags')
    if (existsSync(userTable)) {
      chmodSync(userTable, 0o755)
    }
    rmSync(root, { recursive: true, force: true })
  })

  it("derives for Orca's codex once the shell PATH is ready, and a resume's wait sees it", async () => {
    let pathReady!: () => void
    const ready = new Promise<void>((resolve) => {
      pathReady = resolve
    })
    let waited = false
    const wait = start(ready).then(() => {
      waited = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(waited).toBe(false)
    expect(versionCalls()).toEqual([])

    pathReady()
    await wait

    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
    expect(getKnownCodexHookFlag()).toEqual({ version: 'codex-cli 0.159.2', failure: null })
  })

  it('writes the hook script before any entry, so a codex installed after start runs it', async () => {
    await start()

    expect(existsSync(getManagedScriptPath())).toBe(true)
    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
  })

  it('derives nothing when the hook script cannot be written', async () => {
    mkdirSync(join(root, 'home'))
    // Why a file where the folder goes: the script's mkdir then fails.
    writeFileSync(join(root, 'home', '.orca'), '')

    await start()

    expect(versionCalls()).toEqual([])
    expect(readdirSync(table())).toEqual([])
  })

  it('turns off at once, even mid-derivation, and the derivation then publishes nothing', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.runCodexAppServerSession.mockImplementation(async (invocation, body) => {
      await gate
      return body({ request: async () => listingFor(invocation.args[1]) })
    })
    const first = start()
    await vi.waitFor(() => expect(mocks.runCodexAppServerSession).toHaveBeenCalled())

    enabled = false
    await syncCodexHookFlags()
    expect(existsSync(table())).toBe(false)
    release()
    await first

    expect(existsSync(table())).toBe(false)
  })

  it('spawns nothing for a binary whose fingerprint is unchanged, and re-derives one that changed', async () => {
    await start()
    expect(versionCalls()).toHaveLength(1)

    await syncCodexHookFlags()
    expect(versionCalls()).toHaveLength(1)

    // Why new bytes: an update replaces the binary behind the same path.
    writeBinary(mocks.state.mainPath, 'codex, updated')
    versions.set(mocks.state.mainPath, 'codex-cli 0.160.0')
    await syncCodexHookFlags()

    expect(versionCalls()).toHaveLength(2)
    expect(entryFor('codex-cli 0.160.0')).not.toBeNull()
  })

  it('re-derives when its entry is gone, even for an unchanged binary', async () => {
    await start()
    rmSync(join(table(), 'codex-cli 0.159.2.flag'))

    await syncCodexHookFlags()

    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
  })

  it('reports a Codex older than the minimum, spawning no app-server for it again', async () => {
    versions.set(mocks.state.mainPath, 'codex-cli 0.132.0')
    await start()

    expect(getKnownCodexHookFlag()?.failure).toBe(
      'Codex 0.132.0 is older than 0.133; update Codex for Orca status'
    )
    await syncCodexHookFlags()
    expect(mocks.runCodexAppServerSession).not.toHaveBeenCalled()
    expect(versionCalls()).toHaveLength(1)
  })

  it('caches a failure per fingerprint until the binary changes or hooks are toggled', async () => {
    mocks.runCodexAppServerSession.mockRejectedValue(new Error('timed out'))
    await start()
    expect(getKnownCodexHookFlag()?.failure).toBe('timed out')

    await syncCodexHookFlags()
    expect(versionCalls()).toHaveLength(1)

    enabled = false
    await syncCodexHookFlags()
    enabled = true
    await syncCodexHookFlags()
    expect(versionCalls()).toHaveLength(2)

    writeBinary(mocks.state.mainPath, 'codex, reinstalled')
    await syncCodexHookFlags()
    expect(versionCalls()).toHaveLength(3)
  })

  it('prunes entries whose definition this build no longer writes', async () => {
    mkdirSync(table(), { recursive: true })
    publishCodexHookFlagEntry({
      codexVersion: 'codex-cli 0.1.0',
      flag: 'hooks={old}',
      noDaemon: false
    })

    await start()

    expect(entryFor('codex-cli 0.1.0')).toBeNull()
    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
  })

  it("serves a launch's request for its own binary, through npm's codex.cmd for codex.ps1", async () => {
    await start()
    const npm = join(root, 'npm')
    writeBinary(join(npm, 'codex.ps1'))
    const cmd = writeBinary(join(npm, 'codex.cmd'))
    versions.set(cmd, 'codex-cli 0.150.1')
    putOnPath(npm)
    // Why a BOM: PowerShell 5.1's Set-Content -Encoding UTF8 writes one.
    writeFileSync(join(table(), 'codex-cli 0.150.1.request'), `﻿${join(npm, 'codex.ps1')}\r\n`)

    await syncCodexHookFlags()

    expect(versionCalls()).toContain(cmd)
    expect(entryFor('codex-cli 0.150.1')).not.toBeNull()
  })

  it("derives for Orca's own codex when a request names no codex binary", async () => {
    await start()
    writeFileSync(join(table(), 'codex-cli 9.9.9.request'), '/tmp/evil\n')

    await syncCodexHookFlags()

    expect(versionCalls()).not.toContain('/tmp/evil')
  })

  it('derives for the binary an Orca-side launch names', async () => {
    await start()
    const pane = writeBinary(join(root, 'mise', 'codex'))
    versions.set(pane, 'codex-cli 0.150.1')

    await syncCodexHookFlags({ codexPath: pane })

    expect(entryFor('codex-cli 0.150.1')).not.toBeNull()
  })

  it('syncs on any watch event, whatever name the OS reports', async () => {
    await start()
    const pane = writeBinary(join(root, 'pane', 'codex'))
    versions.set(pane, 'codex-cli 0.150.1')
    putOnPath(join(root, 'pane'))
    writeFileSync(join(table(), 'codex-cli 0.150.1.request'), `${pane}\n`)

    // Why no name: macOS reports a burst under the directory's own name, or none.
    openWatches(table())[0].fire()

    await vi.waitFor(() => expect(entryFor('codex-cli 0.150.1')).not.toBeNull())
  })

  it('drops a failed watch and opens a new one at the next sync', async () => {
    await start()
    const [lost] = openWatches(table())
    lost.watcher.emit('error', new Error('watch lost'))
    expect(lost.watcher.closed).toBe(true)

    await syncCodexHookFlags()

    expect(openWatches(table())).toHaveLength(1)
    expect(watchers.filter((watch) => watch.path === table())).toHaveLength(2)
  })

  // Why AL3: a request is text any process can write, and the path it names is run.
  it("never runs a requested codex outside main's PATH, and serves one on it", async () => {
    await start()
    const evil = writeBinary(join(root, 'evil', 'codex'))
    versions.set(evil, 'codex-cli 0.150.1')
    const onPath = writeBinary(join(root, 'mise', 'shims', 'codex'))
    versions.set(onPath, 'codex-cli 0.150.1')
    writeFileSync(join(table(), 'codex-cli 0.150.1.request'), `${evil}\n`)

    await syncCodexHookFlags()
    expect(versionCalls()).not.toContain(evil)
    expect(entryFor('codex-cli 0.150.1')).toBeNull()

    putOnPath(join(root, 'mise', 'shims'))
    writeFileSync(join(table(), 'codex-cli 0.150.1.request'), `${onPath}\n`)
    await syncCodexHookFlags()

    expect(versionCalls()).toContain(onPath)
    expect(versionCalls()).not.toContain(evil)
    expect(entryFor('codex-cli 0.150.1')).not.toBeNull()
  })

  // Why: macOS assesses a new binary on its first run, measured at 10-12 s for codex.
  it("gives a new codex's first run time to pass macOS's assessment, and status a short wait", async () => {
    await start()
    const derivation = mocks.runProcess.mock.calls.find(
      ([options]) => options.args[0] === '--version'
    )
    expect(derivation?.[0].timeoutMs).toBeGreaterThanOrEqual(30_000)
    stop()
    _internals.resetForTesting()
    mocks.runProcess.mockClear()

    await learnCodexHookFlagVersion()
    const status = mocks.runProcess.mock.calls.find(([options]) => options.args[0] === '--version')
    expect(status?.[0].timeoutMs).toBe(5_000)
  })

  it('watches the table only while hooks are on, and reopens it for a recreated table', async () => {
    await start()
    expect(openWatches(table())).toHaveLength(1)

    enabled = false
    await syncCodexHookFlags()
    expect(watchers.every((watch) => watch.watcher.closed)).toBe(true)

    enabled = true
    await syncCodexHookFlags()
    expect(openWatches(table())).toHaveLength(1)
    expect(watchers.filter((watch) => watch.path === table())).toHaveLength(2)
  })

  it('never throws on a request that is a directory', async () => {
    mkdirSync(join(table(), 'codex-cli 9.9.9.request'), { recursive: true })

    await expect(start()).resolves.toBeUndefined()
    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
  })

  it.skipIf(!canDenyWrites)(
    'never throws when hooks are off and the table cannot be removed',
    async () => {
      mkdirSync(table(), { recursive: true })
      writeFileSync(join(table(), 'codex-cli 9.9.9.request'), '')
      chmodSync(table(), 0o555)
      enabled = false

      expect(() => start()).not.toThrow()
      await expect(syncCodexHookFlags()).resolves.toBeUndefined()
      expect(existsSync(table())).toBe(true)
    }
  )

  // Why S1: a version manager's shim keeps its bytes when the codex behind it updates.
  it('derives for a requested version without an entry, whatever the fingerprint says', async () => {
    await start()
    versions.set(mocks.state.mainPath, 'codex-cli 0.160.0')
    writeFileSync(join(table(), 'codex-cli 0.160.0.request'), `${mocks.state.mainPath}\n`)

    await syncCodexHookFlags()

    expect(entryFor('codex-cli 0.160.0')).not.toBeNull()
  })

  it('caches that a binary answers another version than requested, for that binary only', async () => {
    await start()
    writeFileSync(join(table(), 'codex-cli 0.160.0.request'), `${mocks.state.mainPath}\n`)
    await syncCodexHookFlags()
    const calls = versionCalls().length

    writeFileSync(join(table(), 'codex-cli 0.160.0.request'), `${mocks.state.mainPath}\n`)
    await syncCodexHookFlags()

    expect(versionCalls()).toHaveLength(calls)
  })

  // Why S4: a boot-time timeout must not cost status for the life of the process.
  it('retries a transient failure soon, and a request for a version at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    versions.set(mocks.state.mainPath, 'timeout')
    await start()
    expect(getKnownCodexHookFlag()?.failure).toContain('did not report its version')
    versions.set(mocks.state.mainPath, 'codex-cli 0.159.2')

    await syncCodexHookFlags()
    expect(entryFor('codex-cli 0.159.2')).toBeNull()
    vi.setSystemTime(Date.now() + 61_000)
    await syncCodexHookFlags()
    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
  })

  it('keeps a failure no retry can fix cached past the retry time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    mocks.runCodexAppServerSession.mockRejectedValue(
      Object.assign(new Error('no app-server'), { name: 'CodexAppServerUnsupportedError' })
    )
    await start()
    const calls = versionCalls().length

    vi.setSystemTime(Date.now() + 61_000)
    await syncCodexHookFlags()

    expect(versionCalls()).toHaveLength(calls)
  })

  // Why N3-2: a throw deciding whether to run again must not leave the run marked forever.
  it('recovers when reading the setting throws as a run decides to go again', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.runCodexAppServerSession.mockImplementationOnce(async (invocation, body) => {
      await gate
      return body({ request: async () => listingFor(invocation.args[1]) })
    })
    let broken = false
    stop = startCodexHookFlagSync({
      isEnabled: () => {
        if (broken) {
          throw new Error('settings store unavailable')
        }
        return enabled
      },
      watch: (path, onChange) => fakeWatch(path, onChange)
    })
    const first = syncCodexHookFlagsWithin(5_000)
    await vi.waitFor(() => expect(mocks.runCodexAppServerSession).toHaveBeenCalled())
    void syncCodexHookFlags()
    broken = true
    release()
    await expect(first).resolves.toBeUndefined()

    broken = false
    rmSync(join(table(), 'codex-cli 0.159.2.flag'), { force: true })
    await expect(syncCodexHookFlags()).resolves.toBeUndefined()

    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
  })

  it('lets a request naming the version retry a binary whose plain sync failed', async () => {
    versions.set(mocks.state.mainPath, 'timeout')
    await start()
    versions.set(mocks.state.mainPath, 'codex-cli 0.159.2')
    writeFileSync(join(table(), 'codex-cli 0.159.2.request'), `${mocks.state.mainPath}\n`)

    await syncCodexHookFlags()

    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
  })

  it('forgets a failure from a derivation an opt-out overtook', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.runCodexAppServerSession.mockImplementationOnce(async () => {
      await gate
      throw new Error('timed out')
    })
    const first = start()
    await vi.waitFor(() => expect(mocks.runCodexAppServerSession).toHaveBeenCalled())
    enabled = false
    await syncCodexHookFlags()
    enabled = true
    void syncCodexHookFlags()

    release()
    await first

    // Why: the run after the toggle asks again instead of reusing the old run's failure.
    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
  })

  // Why S5: a call landing between a run's last check and its end must still be served.
  it.each([0, 1, 2, 3, 4, 6, 8])(
    'serves a call landing %i microtasks after a run’s last step',
    async (hops) => {
      await start()
      const pane = writeBinary(join(root, 'pane', 'codex'))
      versions.set(pane, 'codex-cli 0.150.1')
      mocks.state.afterPrune = () => {
        mocks.state.afterPrune = null
        let later: Promise<void> = Promise.resolve()
        for (let hop = 0; hop < hops; hop += 1) {
          later = later.then(() => {})
        }
        void later.then(() => syncCodexHookFlags({ codexPath: pane }))
      }

      await syncCodexHookFlags()
      await vi.waitFor(() => expect(entryFor('codex-cli 0.150.1')).not.toBeNull())
    }
  )

  it('returns from a bounded wait while a sync is still running', async () => {
    mocks.runCodexAppServerSession.mockImplementation(() => new Promise(() => {}))
    startCodexHookFlagSync({ isEnabled: () => enabled, watch: (path) => fakeWatch(path) })

    const started = Date.now()
    await syncCodexHookFlagsWithin(50)

    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('syncs once for a pane spawn that asks several times', async () => {
    await start()
    const creations = mocks.state.tableCreations

    // Why three: one spawn builds its env through several builders, each of which asks.
    scheduleCodexHookFlagSync()
    scheduleCodexHookFlagSync()
    scheduleCodexHookFlagSync()
    await new Promise((resolve) => setImmediate(resolve))

    expect(mocks.state.tableCreations).toBe(creations + 1)
  })

  describe('on Windows, under a profile path only an 8.3 name can carry', () => {
    const hostPlatform = process.platform
    let shortRoot: string

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      vi.stubEnv('HOME', join(root, 'John Smith'))
      vi.stubEnv('USERPROFILE', join(root, 'John Smith'))
      shortRoot = join(root, 'JOHNSM~1')
      const shortScript = () => getManagedScriptPath().replace(join(root, 'John Smith'), shortRoot)
      shortPath = () => {
        mkdirSync(join(shortScript(), '..'), { recursive: true })
        writeFileSync(shortScript(), 'x')
        return shortScript()
      }
      listedCommand = () => getManagedCommand(shortScript())
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
    })

    const cmdCalls = () =>
      mocks.runProcess.mock.calls.filter(([options]) => /cmd\.exe$/i.test(options.program)).length

    // Why S2: the 8.3 lookup spawns cmd.exe, a process per pane spawn otherwise.
    it('spawns nothing on a sync that finds nothing new', async () => {
      await start()
      expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
      const spawned = mocks.runProcess.mock.calls.length

      for (let sync = 0; sync < 5; sync += 1) {
        await syncCodexHookFlags()
      }

      expect(mocks.runProcess.mock.calls.length).toBe(spawned)
    })

    it('spawns no cmd.exe on each sync while codex is not installed', async () => {
      rmSync(mocks.state.mainPath)
      shortPath = () => null
      await start()
      const lookups = cmdCalls()

      for (let sync = 0; sync < 5; sync += 1) {
        await syncCodexHookFlags()
      }

      expect(cmdCalls()).toBe(lookups)
      expect(versionCalls()).toEqual([])
    })

    const noShortName = () =>
      `Codex status needs a short (8.3) name for ${getManagedScriptPath()}, and it has none Orca can use`

    // Why AL4: with 8.3 names off, cmd.exe answers the long path, and status must say why there is no flag.
    it('reports a profile path that has no short name', async () => {
      shortPath = () => getManagedScriptPath()
      await start()

      expect(getKnownCodexHookFlag()?.failure).toBe(noShortName())
      expect(mocks.runCodexAppServerSession).not.toHaveBeenCalled()
    })

    // Why: a `'` stays in the short name, which the flag cannot carry either.
    it("reports a short name that still cannot be carried, as for O'Brien", async () => {
      vi.stubEnv('HOME', join(root, "O'Brien"))
      vi.stubEnv('USERPROFILE', join(root, "O'Brien"))
      shortPath = () => {
        const short = getManagedScriptPath().replace(join(root, "O'Brien"), join(root, "O'BRIE~1"))
        mkdirSync(dirname(short), { recursive: true })
        writeFileSync(short, 'x')
        return short
      }
      await start()

      expect(getKnownCodexHookFlag()?.failure).toBe(noShortName())
    })

    // Why: the lookup refuses a `%` before asking cmd.exe, so no retry can find a name.
    it('reports a path the 8.3 lookup refuses as permanent, asking cmd.exe nothing', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.stubEnv('HOME', join(root, 'John 100%'))
      vi.stubEnv('USERPROFILE', join(root, 'John 100%'))
      await start()
      expect(getKnownCodexHookFlag()?.failure).toBe(noShortName())

      vi.setSystemTime(Date.now() + 61_000)
      await syncCodexHookFlags()

      expect(cmdCalls()).toBe(0)
      expect(versionCalls()).toHaveLength(1)
    })

    it("tells the CLI's status the same", async () => {
      mkdirSync(dirname(getManagedScriptPath()), { recursive: true })
      writeFileSync(getManagedScriptPath(), 'x')
      shortPath = () => getManagedScriptPath()

      await learnCodexHookFlagVersion()

      expect(getKnownCodexHookFlag()?.failure).toBe(noShortName())
    })

    // Why S3: a definition the lookup failed to learn proves no entry stale.
    it('prunes nothing while its 8.3 lookup fails', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      await start()
      const before = readdirSync(table())
      _internals.forgetHookCommandForTesting()
      shortPath = () => null

      await syncCodexHookFlags()

      expect(readdirSync(table())).toEqual(before)
    })
  })

  describe("in the CLI's process", () => {
    it('follows the saved setting without deriving, and does nothing when given none', async () => {
      mkdirSync(table(), { recursive: true })
      await syncCodexHookFlags()
      expect(existsSync(table())).toBe(true)

      await syncCodexHookFlags({ enabled: true })
      expect(existsSync(table())).toBe(true)
      expect(existsSync(getManagedScriptPath())).toBe(true)
      expect(versionCalls()).toEqual([])

      await syncCodexHookFlags({ enabled: false })
      expect(existsSync(table())).toBe(false)
    })

    it('tells status a Codex older than the minimum needs an update', async () => {
      versions.set(mocks.state.mainPath, 'codex-cli 0.131.0')

      await learnCodexHookFlagVersion()

      expect(getKnownCodexHookFlag()).toEqual({
        version: 'codex-cli 0.131.0',
        failure: 'Codex 0.131.0 is older than 0.133; update Codex for Orca status'
      })
    })

    it('learns its codex version for status', async () => {
      await learnCodexHookFlagVersion()

      expect(getKnownCodexHookFlag()).toEqual({ version: 'codex-cli 0.159.2', failure: null })
    })
  })
})
