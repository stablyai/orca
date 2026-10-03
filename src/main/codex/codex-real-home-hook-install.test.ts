import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexManagedTrustGrantPlan } from './codex-hook-trust-grant'
import {
  computeTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries,
  upsertHookTrustEntriesInContent,
  type CodexTrustEntry
} from './config-toml-trust'

const { homedirMock, grantMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  grantMock: vi.fn()
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

vi.mock('./codex-hook-trust-grant', () => ({
  CODEX_TRUST_GRANT_TRANSIENT_RETRY_INTERVAL_MS: 300_000,
  findCurrentManagedCodexHookTrust: async () => null,
  grantManagedCodexHookTrust: grantMock
}))

import {
  ensureRealHomeCodexHookState as startRealHomeCodexHookEnsure,
  getRealHomeCodexHookVerdict,
  removeRealHomeCodexHookForOptOut,
  _internals
} from './codex-real-home-hook-install'

/** The lane once Codex's background approval, if any, has settled. */
async function ensureRealHomeCodexHookState(
  args: Parameters<typeof startRealHomeCodexHookEnsure>[0]
): ReturnType<typeof startRealHomeCodexHookEnsure> {
  await startRealHomeCodexHookEnsure(args)
  return _internals.settledVerdictForTesting()
}
import { getCodexManagedHookInstallMaterial } from './hook-service'
import {
  readCodexTrustGrantLedgerHome,
  writeCodexTrustGrantLedgerHome
} from './codex-trust-grant-ledger'

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

function getRealHooksJsonPath(): string {
  return join(fakeHomeDir, '.codex', 'hooks.json')
}

function getRealConfigTomlPath(): string {
  return join(fakeHomeDir, '.codex', 'config.toml')
}

function readRealHooksJson(): {
  hooks?: Record<string, { hooks?: { command?: string }[] }[]>
  [key: string]: unknown
} {
  return JSON.parse(readFileSync(getRealHooksJsonPath(), 'utf-8'))
}

function grantSucceeds(): void {
  grantMock.mockImplementation((plan: CodexManagedTrustGrantPlan) => ({
    lane: 'rpc',
    entries: plan.managedEntries.map((entry) => ({ ...entry, trustedHash: 'codex-hash' }))
  }))
}

function grantUnavailable(): void {
  grantMock.mockReturnValue({ lane: 'fallback', reason: 'unsupported' })
}

beforeEach(() => {
  grantMock.mockReset()
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-real-home-hooks-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-real-home-hooks-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  mkdirSync(join(fakeHomeDir, '.codex'), { recursive: true })
  _internals.resetForTesting('pending')
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('ensureRealHomeCodexHookState (install)', () => {
  // Why (#16441): every pane launch queues on one process-wide lane, so a failure
  // must resolve to a verdict and leave later ensures their retry.
  it('recovers from a home-resolution failure instead of poisoning later ensures', async () => {
    grantSucceeds()
    homedirMock.mockImplementationOnce(() => {
      throw new Error('home unavailable')
    })

    await expect(
      ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).resolves.toBe('unavailable')
    await expect(
      ensureRealHomeCodexHookState({
        hooksEnabled: false,
        userDataPath: userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).resolves.toBe('removed')
  })

  it('creates hooks.json with the Orca entry in every managed event for a fresh home', async () => {
    grantSucceeds()

    const lane = await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })

    expect(lane).toBe('installed')
    const material = getCodexManagedHookInstallMaterial()
    const config = readRealHooksJson()
    for (const eventName of material.events) {
      const definitions = config.hooks?.[eventName]
      expect(definitions).toHaveLength(1)
      expect(definitions?.[0]?.hooks?.[0]?.command).toBe(material.command)
    }
    // The grant plan targeted the real home with append-position trust keys.
    const plan = grantMock.mock.calls[0]![0] as CodexManagedTrustGrantPlan
    expect(plan.runtimeHomePath).toBe(join(fakeHomeDir, '.codex'))
    expect(plan.host).toEqual({ kind: 'native' })
    expect(plan.useDefaultCodexHome).toBe(true)
    expect(plan.managedEntries.every((entry) => entry.groupIndex === 0)).toBe(true)
  })

  it('keeps a symlinked default home logical in the keys sent to Codex', async () => {
    grantSucceeds()
    const logicalHome = join(fakeHomeDir, '.codex')
    const targetHome = join(fakeHomeDir, 'dotfiles-codex')
    rmSync(logicalHome, { recursive: true })
    mkdirSync(targetHome)
    symlinkSync(targetHome, logicalHome, process.platform === 'win32' ? 'junction' : 'dir')

    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).toBe('installed')

    const plan = grantMock.mock.calls[0]![0] as CodexManagedTrustGrantPlan
    expect(
      plan.managedEntries.map(computeTrustKey).every((key) => key.startsWith(logicalHome))
    ).toBe(true)
  })

  it('keeps the managed lane for unknown top-level fields Codex cannot load', async () => {
    grantSucceeds()
    const userConfig = {
      hooks: {
        Stop: [{ matcher: 'deploy-*', hooks: [{ type: 'command', command: 'my-stop-hook.sh' }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: 'my-compact-hook.sh' }] }]
      },
      _pluginManagerMetadata: { owner: 'someone-else' }
    }
    const original = `${JSON.stringify(userConfig, null, 2)}\n`
    writeFileSync(getRealHooksJsonPath(), original, 'utf-8')

    const lane = await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })

    expect(lane).toBe('unavailable')
    expect(readFileSync(getRealHooksJsonPath(), 'utf-8')).toBe(original)
    expect(grantMock).not.toHaveBeenCalled()
    expect(existsSync(join(userDataDir, 'codex-real-home-hooks', 'hooks.json.pre-orca'))).toBe(
      false
    )
  })

  it('appends LAST and preserves user entries and trust positions', async () => {
    grantSucceeds()
    const userConfig = {
      hooks: {
        Stop: [{ matcher: 'deploy-*', hooks: [{ type: 'command', command: 'my-stop-hook.sh' }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: 'my-compact-hook.sh' }] }]
      }
    }
    const original = `${JSON.stringify(userConfig, null, 2)}\n`
    writeFileSync(getRealHooksJsonPath(), original, 'utf-8')

    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).toBe('installed')

    const config = readRealHooksJson()
    expect(config.hooks?.Stop).toHaveLength(2)
    expect(config.hooks?.Stop?.[0]).toEqual(userConfig.hooks.Stop[0])
    expect(config.hooks?.PreCompact).toEqual(userConfig.hooks.PreCompact)
    const plan = grantMock.mock.calls[0]![0] as CodexManagedTrustGrantPlan
    expect(plan.managedEntries.find((entry) => entry.eventLabel === 'stop')?.groupIndex).toBe(1)
    expect(
      readFileSync(join(userDataDir, 'codex-real-home-hooks', 'hooks.json.pre-orca'), 'utf-8')
    ).toBe(original)
  })

  // Why: ordinary Windows CI tokens cannot create file symlinks without Developer Mode.
  it.skipIf(process.platform === 'win32')(
    'updates a symlinked hooks.json target without replacing the symlink',
    async () => {
      grantSucceeds()
      const dotfilesDir = join(fakeHomeDir, 'dotfiles')
      const targetPath = join(dotfilesDir, 'hooks.json')
      mkdirSync(dotfilesDir, { recursive: true })
      writeFileSync(
        targetPath,
        `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } }, null, 2)}\n`,
        'utf-8'
      )
      symlinkSync(targetPath, getRealHooksJsonPath())

      expect(
        await ensureRealHomeCodexHookState({
          hooksEnabled: true,
          userDataPath: userDataDir,
          writePolicy: 'add-missing-only'
        })
      ).toBe('installed')

      expect(lstatSync(getRealHooksJsonPath()).isSymbolicLink()).toBe(true)
      expect(JSON.parse(readFileSync(targetPath, 'utf-8')).hooks.Stop).toHaveLength(2)
    }
  )

  it('keeps the managed lane and original bytes when the pristine backup cannot be created', async () => {
    grantSucceeds()
    const original = `${JSON.stringify({ hooks: { Stop: [] } }, null, 2)}\n`
    writeFileSync(getRealHooksJsonPath(), original, 'utf-8')
    writeFileSync(join(userDataDir, 'codex-real-home-hooks'), 'blocks backup directory', 'utf-8')

    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).toBe('unavailable')

    expect(readFileSync(getRealHooksJsonPath(), 'utf-8')).toBe(original)
    expect(grantMock).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'preserves restrictive hooks.json permissions',
    async () => {
      grantSucceeds()
      writeFileSync(getRealHooksJsonPath(), '{ "hooks": {} }\n', 'utf-8')
      chmodSync(getRealHooksJsonPath(), 0o600)

      expect(
        await ensureRealHomeCodexHookState({
          hooksEnabled: true,
          userDataPath: userDataDir,
          writePolicy: 'add-missing-only'
        })
      ).toBe('installed')

      expect(statSync(getRealHooksJsonPath()).mode & 0o777).toBe(0o600)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps restrictive hooks.json permissions after withdrawing on grant fallback',
    async () => {
      grantUnavailable()
      writeFileSync(getRealHooksJsonPath(), '{ "hooks": {} }\n', 'utf-8')
      chmodSync(getRealHooksJsonPath(), 0o600)

      expect(
        await ensureRealHomeCodexHookState({
          hooksEnabled: true,
          userDataPath: userDataDir,
          writePolicy: 'add-missing-only'
        })
      ).toBe('unavailable')

      expect(statSync(getRealHooksJsonPath()).mode & 0o777).toBe(0o600)
    }
  )

  it('withdraws its untrusted entries to the prior bytes when the grant lane is unavailable', async () => {
    grantUnavailable()
    const userRaw = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } }, null, 2)}\n`
    writeFileSync(getRealHooksJsonPath(), userRaw, 'utf-8')

    const lane = await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })

    expect(lane).toBe('unavailable')
    expect(getRealHomeCodexHookVerdict()).toBe('unavailable')
    expect(readFileSync(getRealHooksJsonPath(), 'utf-8')).toBe(userRaw)
  })

  it('withdraws its entries from a hooks.json it created when the grant lane is unavailable', async () => {
    grantUnavailable()

    const lane = await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })

    expect(lane).toBe('unavailable')
    expect(readRealHooksJson()).toEqual({ hooks: {} })
  })

  it.skipIf(process.platform === 'win32')(
    'surfaces a withdrawal that cannot write to the retry boundary',
    async () => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const codexDir = join(fakeHomeDir, '.codex')
      grantMock.mockImplementation(() => {
        chmodSync(codexDir, 0o500)
        return { lane: 'fallback', reason: 'unsupported' }
      })

      try {
        expect(
          await ensureRealHomeCodexHookState({
            hooksEnabled: true,
            userDataPath: userDataDir,
            writePolicy: 'add-missing-only'
          })
        ).toBe('unavailable')
      } finally {
        chmodSync(codexDir, 0o700)
      }

      expect(warning).toHaveBeenCalledWith(
        '[codex-real-home-hooks] background trust grant failed:',
        expect.any(Error)
      )
    }
  )

  it('does no hook-file or grant work on repeated unsupported launches', async () => {
    grantUnavailable()
    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).toBe('unavailable')
    const afterFirst = readFileSync(getRealHooksJsonPath(), 'utf-8')

    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).toBe('unavailable')

    expect(grantMock).toHaveBeenCalledTimes(1)
    expect(readFileSync(getRealHooksJsonPath(), 'utf-8')).toBe(afterFirst)
  })

  it('leaves an unparseable hooks.json untouched and keeps the managed lane', async () => {
    writeFileSync(getRealHooksJsonPath(), '{not json', 'utf-8')

    const lane = await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })

    expect(lane).toBe('unavailable')
    expect(readFileSync(getRealHooksJsonPath(), 'utf-8')).toBe('{not json')
    expect(grantMock).not.toHaveBeenCalled()
  })

  it('is idempotent: a second ensure keeps a single appended entry per event', async () => {
    grantSucceeds()
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
    const firstRaw = readFileSync(getRealHooksJsonPath(), 'utf-8')

    const lane = await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })

    expect(lane).toBe('installed')
    expect(readFileSync(getRealHooksJsonPath(), 'utf-8')).toBe(firstRaw)
  })

  it('keeps later user hook trust positions stable when reconciling an existing install', async () => {
    grantSucceeds()
    const userBefore = { hooks: [{ type: 'command', command: 'before.sh' }] }
    writeFileSync(
      getRealHooksJsonPath(),
      `${JSON.stringify({ hooks: { Stop: [userBefore] } }, null, 2)}\n`,
      'utf-8'
    )
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
    const installed = readRealHooksJson()
    const userAfter = { hooks: [{ type: 'command', command: 'after.sh' }] }
    installed.hooks!.Stop!.push(userAfter)
    writeFileSync(getRealHooksJsonPath(), `${JSON.stringify(installed, null, 2)}\n`, 'utf-8')

    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).toBe('installed')

    const reconciled = readRealHooksJson().hooks?.Stop
    expect(reconciled?.[0]).toEqual(userBefore)
    expect(reconciled?.[2]).toEqual(userAfter)
    const plan = grantMock.mock.calls.at(-1)![0] as CodexManagedTrustGrantPlan
    expect(plan.managedEntries.find((entry) => entry.eventLabel === 'stop')?.groupIndex).toBe(1)
  })

  it("keeps later user handler trust positions stable inside Orca's hook group", async () => {
    grantSucceeds()
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
    const installed = readRealHooksJson()
    const userAfter = { type: 'command', command: 'after.sh' }
    installed.hooks!.Stop![0]!.hooks!.push(userAfter)
    writeFileSync(getRealHooksJsonPath(), `${JSON.stringify(installed, null, 2)}\n`, 'utf-8')

    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).toBe('installed')

    expect(readRealHooksJson().hooks?.Stop?.[0]?.hooks?.[1]).toEqual(userAfter)
    const plan = grantMock.mock.calls.at(-1)![0] as CodexManagedTrustGrantPlan
    const stopEntry = plan.managedEntries.find((entry) => entry.eventLabel === 'stop')
    expect(stopEntry).toMatchObject({ groupIndex: 0, handlerIndex: 0 })
  })

  it("leaves a hooks-on Orca's entry and trust alone when a hooks-off Orca prepares a launch", async () => {
    grantSucceeds()
    writeFileSync(getRealConfigTomlPath(), 'model = "gpt-5"\n', 'utf-8')
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
    const hooksBefore = readFileSync(getRealHooksJsonPath(), 'utf-8')
    const tomlBefore = readFileSync(getRealConfigTomlPath(), 'utf-8')
    // A second Orca process, with status hooks off, sharing this ~/.codex.
    _internals.resetForTesting('pending')

    await expect(
      ensureRealHomeCodexHookState({
        hooksEnabled: false,
        userDataPath: join(userDataDir, 'other-profile'),
        writePolicy: 'add-missing-only'
      })
    ).resolves.toBe('removed')

    expect(readFileSync(getRealHooksJsonPath(), 'utf-8')).toBe(hooksBefore)
    expect(readFileSync(getRealConfigTomlPath(), 'utf-8')).toBe(tomlBefore)
  })
})

describe('removeRealHomeCodexHookForOptOut', () => {
  it('keeps the managed lane when hooks.json cannot be read', async () => {
    mkdirSync(getRealHooksJsonPath())

    expect(await removeRealHomeCodexHookForOptOut()).toBe('unavailable')
  })

  it("keeps Orca's trust and its ledger when hooks.json cannot be read", async () => {
    const entry: CodexTrustEntry = {
      sourcePath: getRealHooksJsonPath(),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: getCodexManagedHookInstallMaterial().command,
      timeoutSec: 10
    }
    writeFileSync(getRealConfigTomlPath(), upsertHookTrustEntriesInContent('', [entry]), 'utf-8')
    writeCodexTrustGrantLedgerHome(join(fakeHomeDir, '.codex'), { binary: null, entries: {} })
    mkdirSync(getRealHooksJsonPath())

    expect(await removeRealHomeCodexHookForOptOut()).toBe('unavailable')

    // The entry may still be there, so its trust must be too.
    expect(readHookTrustEntries(getRealConfigTomlPath()).has(computeTrustKey(entry))).toBe(true)
    expect(readCodexTrustGrantLedgerHome(join(fakeHomeDir, '.codex'))).not.toBeNull()
  })

  it('keeps the managed lane when hooks.json is malformed', async () => {
    writeFileSync(getRealHooksJsonPath(), '{ not json', 'utf-8')

    expect(await removeRealHomeCodexHookForOptOut()).toBe('unavailable')
    expect(readFileSync(getRealHooksJsonPath(), 'utf-8')).toBe('{ not json')
  })

  it('moves the trust of a user hook appended after Orca when the opt-out removes Orca', async () => {
    grantSucceeds()
    const before = { type: 'command', command: 'before.sh' }
    writeFileSync(
      getRealHooksJsonPath(),
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [before] }] } }, null, 2)}\n`
    )
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
    const installed = readRealHooksJson()
    const after = { type: 'command', command: 'after.sh' }
    installed.hooks!.Stop!.push({ hooks: [after] })
    writeFileSync(getRealHooksJsonPath(), `${JSON.stringify(installed, null, 2)}\n`)
    const afterAt = (groupIndex: number) => ({
      sourcePath: getRealHooksJsonPath(),
      eventLabel: 'stop' as const,
      groupIndex,
      handlerIndex: 0,
      command: 'after.sh'
    })
    upsertHookTrustEntries(getRealConfigTomlPath(), [
      { ...afterAt(2), trustedHash: 'sha256:user-approved' }
    ])

    expect(await removeRealHomeCodexHookForOptOut()).toBe('removed')

    expect(readRealHooksJson().hooks?.Stop).toEqual([{ hooks: [before] }, { hooks: [after] }])
    const trust = readHookTrustEntries(getRealConfigTomlPath())
    expect(trust.get(computeTrustKey(afterAt(1)))?.trustedHash).toBe('sha256:user-approved')
    expect(trust.get(computeTrustKey(afterAt(2)))).toBeUndefined()
  })

  it('removes only Orca entries and reports the removed lane', async () => {
    grantSucceeds()
    const userStop = {
      matcher: 'deploy-*',
      hooks: [{ type: 'command', command: 'my-stop-hook.sh' }]
    }
    writeFileSync(
      getRealHooksJsonPath(),
      `${JSON.stringify({ hooks: { Stop: [userStop] } }, null, 2)}\n`,
      'utf-8'
    )
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: userDataDir,
      writePolicy: 'add-missing-only'
    })
    expect(readRealHooksJson().hooks?.Stop).toHaveLength(2)

    const lane = await removeRealHomeCodexHookForOptOut()

    expect(lane).toBe('removed')
    const config = readRealHooksJson()
    expect(config.hooks?.Stop).toEqual([userStop])
    const material = getCodexManagedHookInstallMaterial()
    for (const eventName of material.events) {
      if (eventName === 'Stop') {
        continue
      }
      expect(config.hooks?.[eventName]).toBeUndefined()
    }
  })

  it('no-ops the sweep when the real home has no hooks.json', async () => {
    const lane = await removeRealHomeCodexHookForOptOut()

    expect(lane).toBe('removed')
    expect(existsSync(getRealHooksJsonPath())).toBe(false)
  })

  it('removes only hash-proven Orca trust from a mixed hook group', async () => {
    const material = getCodexManagedHookInstallMaterial()
    const userCommand = 'my-user-hook.sh'
    writeFileSync(
      getRealHooksJsonPath(),
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: 'command', command: userCommand },
                  { type: 'command', command: material.command, timeout: 10 }
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    const entries: CodexTrustEntry[] = [
      {
        sourcePath: getRealHooksJsonPath(),
        eventLabel: 'stop',
        groupIndex: 0,
        handlerIndex: 0,
        command: userCommand
      },
      {
        sourcePath: getRealHooksJsonPath(),
        eventLabel: 'stop',
        groupIndex: 0,
        handlerIndex: 1,
        command: material.command,
        timeoutSec: 10
      }
    ]
    writeFileSync(getRealConfigTomlPath(), upsertHookTrustEntriesInContent('', entries), 'utf-8')

    expect(await removeRealHomeCodexHookForOptOut()).toBe('removed')

    expect(readRealHooksJson().hooks?.Stop).toEqual([
      { hooks: [{ type: 'command', command: userCommand }] }
    ])
    const trust = readHookTrustEntries(getRealConfigTomlPath())
    expect(trust.has(computeTrustKey(entries[0]!))).toBe(true)
    expect(trust.has(computeTrustKey(entries[1]!))).toBe(false)
  })
})
