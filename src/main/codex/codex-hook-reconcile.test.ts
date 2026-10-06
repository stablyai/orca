import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapPosixHookCommand } from '../agent-hooks/installer-utils'
import type * as CodexCommand from '../codex-cli/command'
import type * as TrustDerivation from './codex-hook-trust-derivation'
import type * as RealHomeInstall from './codex-real-home-hook-install'

const mocks = vi.hoisted(() => {
  const held: { holdRealHome: Promise<void> | null } = { holdRealHome: null }
  return {
    ...held,
    homedir: vi.fn<() => string>(),
    codexPath: '',
    probeCodexVersion: vi.fn(),
    deriveCodexHookHashes: vi.fn(),
    realHomeRuns: 0
  }
})

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: mocks.homedir
}))
vi.mock('../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCommand>()),
  resolveCodexCommand: () => mocks.codexPath
}))
vi.mock('./codex-hook-trust-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustDerivation>()),
  probeCodexVersion: mocks.probeCodexVersion,
  deriveCodexHookHashes: mocks.deriveCodexHookHashes
}))
vi.mock('./codex-real-home-hook-install', async (importOriginal) => {
  const actual = await importOriginal<typeof RealHomeInstall>()
  return {
    ...actual,
    reconcileRealHomeCodexHookEntries: (
      ...args: Parameters<typeof actual.reconcileRealHomeCodexHookEntries>
    ) => {
      mocks.realHomeRuns += 1
      return (mocks.holdRealHome ?? Promise.resolve()).then(() =>
        actual.reconcileRealHomeCodexHookEntries(...args)
      )
    }
  }
})

import {
  _internals,
  reconcileCodexHooks,
  reconcileCodexHooksForLaunch,
  scheduleCodexHookReconcile,
  startCodexHooks
} from './codex-hook-reconcile'
import { _internals as lookupInternals } from './codex-hook-hash-lookup'
import { readRealHomeHooksFileProblem } from './codex-real-home-hooks-json'
import { readCurrentCodexHookStatus } from './codex-hook-status'
import { writeCodexTrustGrantLedgerHome } from './codex-trust-grant-ledger'
import { getCodexHookTrustSignature } from './codex-hook-identity'
import {
  buildCodexManagedHook,
  CODEX_EVENT_LABEL,
  computeOrcaCodexHookHashes,
  getCodexManagedHookInstallMaterial
} from './codex-hook-definition'
import type { CodexHookHashes } from './codex-hook-trust-derivation'
import { computeTrustKey, readHookTrustEntries, upsertHookTrustEntries } from './config-toml-trust'

// Why this file: the reconcile is the only writer of Orca's entry in ~/.codex,
// and the common call, on every pane spawn and Codex launch, must change nothing.

let root: string
let home: string
let userData: string
let enabled: boolean
let usesRealHome: boolean

const CODEX_HASHES: CodexHookHashes = Object.fromEntries(
  Object.values(CODEX_EVENT_LABEL).map((label) => [label, `sha256:codex-${label}`])
)
const codexHome = (): string => join(home, '.codex')
const hooksPath = (): string => join(codexHome(), 'hooks.json')
const tomlPath = (): string => join(codexHome(), 'config.toml')
const command = (): string => getCodexManagedHookInstallMaterial().command

type Hooks = Record<string, { hooks: { type: string; command: string; timeout?: number }[] }[]>

function readHooks(): Hooks {
  return JSON.parse(readFileSync(hooksPath(), 'utf-8')).hooks
}

function writeHooks(hooks: Hooks): void {
  mkdirSync(codexHome(), { recursive: true })
  writeFileSync(hooksPath(), `${JSON.stringify({ hooks }, null, 2)}\n`)
}

function olderBuildStop(): Hooks[string][number] {
  const script = join(home, '.orca', 'agent-hooks', 'codex-hook.sh')
  return {
    hooks: [
      buildCodexManagedHook(
        process.platform === 'win32' ? script : wrapPosixHookCommand(script),
        'Stop'
      )
    ]
  }
}

function snapshot(dir: string): Map<string, { bytes: string; mtimeMs: number }> {
  return new Map(
    existsSync(dir)
      ? readdirSync(dir).map((name) => {
          const path = join(dir, name)
          return [name, { bytes: readFileSync(path, 'utf-8'), mtimeMs: statSync(path).mtimeMs }]
        })
      : []
  )
}

async function start(pathReady: Promise<unknown> = Promise.resolve()): Promise<void> {
  startCodexHooks({
    isEnabled: () => enabled,
    resolveLaunchHome: () => (usesRealHome ? null : join(userData, 'codex-runtime-home')),
    pathReady
  })
  await _internals.settledForTesting()
}

async function settleSpawn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await _internals.settledForTesting()
}

beforeEach(() => {
  // Why realpath: a symlinked temp dir (macOS /var) would give ~/.codex a second key spelling.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-codex-reconcile-')))
  home = join(root, 'home')
  userData = join(root, 'user-data')
  mkdirSync(home)
  mkdirSync(userData)
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  vi.stubEnv('CODEX_HOME', '')
  mocks.homedir.mockReturnValue(home)
  mocks.codexPath = join(userData, 'codex')
  writeFileSync(mocks.codexPath, 'codex 0.160.1')
  mocks.probeCodexVersion.mockResolvedValue('codex-cli 0.160.1')
  mocks.deriveCodexHookHashes.mockResolvedValue({
    kind: 'hashes',
    codexVersion: 'codex-cli 0.160.1',
    hashes: CODEX_HASHES
  })
  mocks.realHomeRuns = 0
  mocks.holdRealHome = null
  enabled = true
  usesRealHome = true
  _internals.resetForTesting()
  lookupInternals.resetForTesting()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('reconcileCodexHooks', () => {
  it('writes the entry last in every listed event, approved, at app start', async () => {
    writeHooks({ Stop: [{ hooks: [{ type: 'command', command: 'user-stop.sh' }] }] })

    await start()

    expect(readHooks().Stop!.map((group) => group.hooks[0]!.command)).toEqual([
      'user-stop.sh',
      command()
    ])
    const key = computeTrustKey({
      sourcePath: hooksPath(),
      eventLabel: 'stop',
      groupIndex: 1,
      handlerIndex: 0,
      command: command()
    })
    expect(readHookTrustEntries(tomlPath()).get(key)).toEqual({
      trustedHash: CODEX_HASHES.stop,
      enabled: true
    })
  })

  it('asks Codex and converts an older build only once PATH is hydrated, with launches waiting on it', async () => {
    writeHooks({ Stop: [olderBuildStop()] })
    let hydrate!: () => void
    const started = start(
      new Promise<void>((resolve) => {
        hydrate = resolve
      })
    )
    const launch = reconcileCodexHooksForLaunch()
    // Why past the reconcile's 500 ms answer wait: an early run would write its stopgap by then.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(mocks.probeCodexVersion).not.toHaveBeenCalled()
    expect(mocks.realHomeRuns).toBe(0)

    hydrate()
    await Promise.all([started, launch])

    expect(mocks.realHomeRuns).toBe(1)
    expect(readHooks().Stop).toEqual([{ hooks: [buildCodexManagedHook(command(), 'Stop')] }])
  })

  it('writes nothing for a launch while hooks are off', async () => {
    enabled = false
    await start()

    await reconcileCodexHooksForLaunch()

    expect(existsSync(codexHome())).toBe(false)
  })

  it('writes nothing and spawns nothing across many concurrent launches when nothing changed', async () => {
    await start()
    const before = snapshot(codexHome())
    const memoBefore = snapshot(userData)
    vi.clearAllMocks()

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        scheduleCodexHookReconcile()
        return index % 2 === 0 ? reconcileCodexHooksForLaunch() : reconcileCodexHooks()
      })
    )
    await settleSpawn()

    expect(snapshot(codexHome())).toEqual(before)
    expect(snapshot(userData)).toEqual(memoBefore)
    expect(mocks.probeCodexVersion).not.toHaveBeenCalled()
    expect(mocks.deriveCodexHookHashes).not.toHaveBeenCalled()
  })

  it('runs again once for every call made while one runs', async () => {
    await start()
    mocks.realHomeRuns = 0
    let release!: () => void
    mocks.holdRealHome = new Promise((resolve) => {
      release = resolve
    })
    const first = reconcileCodexHooks()
    await vi.waitFor(() => expect(mocks.realHomeRuns).toBe(1))

    const later = [2, 3, 4, 5].map(() => reconcileCodexHooks())
    mocks.holdRealHome = null
    release()
    await Promise.all([first, ...later])

    expect(mocks.realHomeRuns).toBe(2)
  })

  it('runs once for one spawn, however many env builders it goes through', async () => {
    await start()
    mocks.realHomeRuns = 0

    scheduleCodexHookReconcile()
    scheduleCodexHookReconcile()
    scheduleCodexHookReconcile()
    await settleSpawn()

    expect(mocks.realHomeRuns).toBe(1)
  })

  it('lets a spawn ride a reconcile already running, which reads the files after it', async () => {
    await start()
    mocks.realHomeRuns = 0
    let release!: () => void
    mocks.holdRealHome = new Promise((resolve) => {
      release = resolve
    })
    const running = reconcileCodexHooks()
    await vi.waitFor(() => expect(mocks.realHomeRuns).toBe(1))

    scheduleCodexHookReconcile()
    await new Promise((resolve) => setImmediate(resolve))
    mocks.holdRealHome = null
    release()
    await running
    await settleSpawn()

    expect(mocks.realHomeRuns).toBe(1)
  })

  it("leaves an older build's entry alone on a pane spawn, and converts it at app start", async () => {
    await start()
    writeHooks({ Stop: [olderBuildStop()] })

    scheduleCodexHookReconcile()
    await settleSpawn()
    expect(readHooks().Stop).toEqual([olderBuildStop()])

    await reconcileCodexHooks({ convertOlderForms: true })
    expect(readHooks().Stop).toEqual([{ hooks: [buildCodexManagedHook(command(), 'Stop')] }])
  })

  it.each([
    ['hooks are off', () => (enabled = false), () => (enabled = true)],
    ['a managed account is selected', () => (usesRealHome = false), () => (usesRealHome = true)]
  ])(
    'keeps an app-start conversion while %s, for the first run that writes ~/.codex',
    async (_case, block, unblock) => {
      writeHooks({ Stop: [olderBuildStop()] })
      block()
      await start()

      unblock()
      scheduleCodexHookReconcile()
      await settleSpawn()

      expect(readHooks().Stop).toEqual([{ hooks: [buildCodexManagedHook(command(), 'Stop')] }])
    }
  )

  it("writes nothing while the next pane's home is not known yet", async () => {
    startCodexHooks({
      isEnabled: () => true,
      resolveLaunchHome: () => {
        throw new Error('not ready')
      },
      pathReady: Promise.resolve()
    })
    await _internals.settledForTesting()

    expect(existsSync(codexHome())).toBe(false)
  })

  it('leaves ~/.codex untouched while a managed account or custom CODEX_HOME is selected', async () => {
    usesRealHome = false

    await start()
    scheduleCodexHookReconcile()
    await settleSpawn()

    expect(existsSync(codexHome())).toBe(false)
  })

  it('still writes for a launch that runs on ~/.codex whatever the selection', async () => {
    usesRealHome = false
    await start()

    await reconcileCodexHooksForLaunch()

    expect(Object.keys(readHooks())).toContain('Stop')
  })

  it('writes nothing for a Codex without hooks/list', async () => {
    mocks.deriveCodexHookHashes.mockResolvedValue({
      kind: 'refused',
      codexVersion: 'codex-cli 0.120.0',
      failure: 'Codex 0.120.0 is too old for Orca status; update Codex'
    })

    await start()

    expect(existsSync(codexHome())).toBe(false)
  })

  it('creates no ~/.codex while Codex cannot be found, and says so', async () => {
    mocks.codexPath = join(userData, 'missing-codex')

    await start()
    await reconcileCodexHooksForLaunch()

    expect(existsSync(codexHome())).toBe(false)
    expect(readCurrentCodexHookStatus().detail).toBe(
      `Orca could not find Codex at ${mocks.codexPath}`
    )
  })

  it("leaves Orca's entry and approvals in ~/.codex as they are while Codex cannot be found", async () => {
    await start()
    writeHooks({ Stop: [olderBuildStop()] })
    const before = snapshot(codexHome())
    mocks.codexPath = join(userData, 'missing-codex')

    await reconcileCodexHooks({ convertOlderForms: true })

    expect(snapshot(codexHome())).toEqual(before)
  })

  it('never throws, and does nothing outside the app', async () => {
    writeHooks({ Stop: [] })
    await expect(reconcileCodexHooks({ convertOlderForms: true })).resolves.toBeUndefined()
    expect(readHooks()).toEqual({ Stop: [] })
  })
})

describe("warming Codex's answer at app start", () => {
  it('asks once the shell PATH is hydrated, while panes use a managed home too', async () => {
    usesRealHome = false
    let hydrate: () => void = () => {}
    const started = start(
      new Promise<void>((resolve) => {
        hydrate = resolve
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mocks.probeCodexVersion).not.toHaveBeenCalled()

    hydrate()
    await started

    await vi.waitFor(() => expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(1))
  })

  it('does not ask while hooks are off', async () => {
    enabled = false
    await start()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(mocks.probeCodexVersion).not.toHaveBeenCalled()
  })
})

describe('while the lookup is still asking Codex', () => {
  function holdDerivation(): () => void {
    let release!: () => void
    const answered = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.deriveCodexHookHashes.mockImplementation(async () => {
      await answered
      return { kind: 'hashes', codexVersion: 'codex-cli 0.161.0', hashes: CODEX_HASHES }
    })
    mocks.probeCodexVersion.mockResolvedValue('codex-cli 0.161.0')
    return release
  }

  const stopApproval = (): string | undefined =>
    readHookTrustEntries(tomlPath()).get(
      computeTrustKey({
        sourcePath: hooksPath(),
        eventLabel: 'stop',
        groupIndex: 0,
        handlerIndex: 0,
        command: command()
      })
    )?.trustedHash

  it("writes the entry with Orca's own hash within a launch's wait, then Codex's once it answers", async () => {
    enabled = false
    await start()
    enabled = true
    const release = holdDerivation()

    const startedAt = Date.now()
    await reconcileCodexHooksForLaunch()

    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(stopApproval()).toBe(computeOrcaCodexHookHashes().stop)

    release()
    await vi.waitFor(() => expect(stopApproval()).toBe(CODEX_HASHES.stop))
  })

  it('writes nothing while an entry is already in place', async () => {
    await start()
    const before = snapshot(codexHome())
    // Why new bytes: a Codex update the lookup has not asked about yet.
    writeFileSync(mocks.codexPath, 'codex 0.161.0')
    const release = holdDerivation()

    await reconcileCodexHooksForLaunch()
    expect(snapshot(codexHome())).toEqual(before)

    const runsBeforeAnswer = mocks.realHomeRuns
    release()
    await vi.waitFor(() => expect(mocks.realHomeRuns).toBe(runsBeforeAnswer + 1))
    await _internals.settledForTesting()
    expect(snapshot(codexHome())).toEqual(before)
  })
})

describe('a ~/.codex/hooks.json Orca cannot add to', () => {
  it.each([
    ['an unparseable file', '{ not json'],
    ['unknown top-level fields', JSON.stringify({ hooks: {}, _managed: true })],
    ['a hooks value that is not an object', JSON.stringify({ hooks: [] })],
    ['an event that is not a list', JSON.stringify({ hooks: { Stop: { note: 'mine' } } })]
  ])(
    'is left byte-for-byte and named as the reason for %s, until it is fixed',
    async (_case, content) => {
      mkdirSync(codexHome(), { recursive: true })
      writeFileSync(hooksPath(), content)

      await start()

      expect(readFileSync(hooksPath(), 'utf-8')).toBe(content)
      expect(existsSync(tomlPath())).toBe(false)
      expect(readRealHomeHooksFileProblem()).toBe(
        `Orca cannot add its hook to ${hooksPath()}, so Orca shows no status for ~/.codex`
      )

      writeHooks({})
      expect(readRealHomeHooksFileProblem()).toBeNull()
    }
  )

  it('is not the case with no hooks.json at all', () => {
    expect(readRealHomeHooksFileProblem()).toBeNull()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'is not the case for an unreadable hooks.json',
    () => {
      writeHooks({})
      chmodSync(hooksPath(), 0o000)

      expect(readRealHomeHooksFileProblem()).toBeNull()
    }
  )

  it('is not the case after a write Orca could not make', async () => {
    writeHooks({})
    writeFileSync(tomlPath(), 'model = "m"\nhooks = { state = {} }\n')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await start()

    expect(readHooks()).toEqual({})
    expect(readRealHomeHooksFileProblem()).toBeNull()
  })
})

describe("a ~/.codex/hooks.json with Codex's description key", () => {
  it('takes the entry and keeps the description verbatim', async () => {
    mkdirSync(codexHome(), { recursive: true })
    writeFileSync(hooksPath(), JSON.stringify({ description: 'My hooks — keep me', hooks: {} }))

    await start()

    const written = JSON.parse(readFileSync(hooksPath(), 'utf-8'))
    expect(written.description).toBe('My hooks — keep me')
    expect(
      written.hooks.Stop.map((group: Hooks[string][number]) => group.hooks[0]!.command)
    ).toEqual([command()])
    expect(readRealHomeHooksFileProblem()).toBeNull()
  })
})

describe('an app start whose lookup has not answered within its wait', () => {
  it("keeps the saved answer's entries, writing nothing, when the version probe is slow", async () => {
    const before0150 = Object.fromEntries(
      Object.entries(CODEX_HASHES).filter(([label]) => label !== 'interrupt')
    )
    mocks.probeCodexVersion.mockResolvedValue('codex-cli 0.149.0')
    mocks.deriveCodexHookHashes.mockResolvedValue({
      kind: 'hashes',
      codexVersion: 'codex-cli 0.149.0',
      hashes: before0150
    })
    await start()
    const settled = snapshot(codexHome())
    // A restart: in-process answers gone, the saved one kept, and `codex --version` slow.
    _internals.resetForTesting()
    lookupInternals.resetForTesting()
    mocks.probeCodexVersion.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('codex-cli 0.149.0'), 900))
    )

    await start()
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await _internals.settledForTesting()

    expect(snapshot(codexHome())).toEqual(settled)
  })

  it("keeps the approval main's grant recorded for Orca's entry", async () => {
    const stop = {
      sourcePath: hooksPath(),
      eventLabel: 'stop' as const,
      groupIndex: 0,
      handlerIndex: 0,
      command: command(),
      timeoutSec: 10
    }
    writeHooks({ Stop: [{ hooks: [buildCodexManagedHook(command(), 'Stop')] }] })
    upsertHookTrustEntries(tomlPath(), [{ ...stop, trustedHash: 'sha256:main-granted' }])
    writeCodexTrustGrantLedgerHome(codexHome(), {
      binary: null,
      entries: {
        [computeTrustKey(stop)]: {
          signature: getCodexHookTrustSignature(stop),
          trustedHash: 'sha256:main-granted'
        }
      }
    })
    mocks.deriveCodexHookHashes.mockImplementation(() => new Promise(() => {}))

    await start()

    expect(readHookTrustEntries(tomlPath()).get(computeTrustKey(stop))?.trustedHash).toBe(
      'sha256:main-granted'
    )
  })
})
