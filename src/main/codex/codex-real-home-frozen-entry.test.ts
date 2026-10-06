import { describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as Os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapPosixHookCommand, type HookDefinition } from '../agent-hooks/installer-utils'
import type { CodexHookTrustGrantRequest } from './codex-app-server-client'
import { _internals as grantInternals } from './codex-hook-trust-grant'
import {
  computeTrustedHash,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries
} from './config-toml-trust'
import { setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock, resolveCodexCommandMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>(),
  resolveCodexCommandMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: resolveCodexCommandMock }))

import {
  _internals as realHomeInternals,
  ensureRealHomeCodexHookState as startRealHomeCodexHookEnsure,
  type RealHomeCodexHookWritePolicy
} from './codex-real-home-hook-install'

/** The lane once Codex's background approval, if any, has settled. */
async function ensureRealHomeCodexHookState(
  args: Parameters<typeof startRealHomeCodexHookEnsure>[0]
): ReturnType<typeof startRealHomeCodexHookEnsure> {
  await startRealHomeCodexHookEnsure(args)
  return realHomeInternals.settledVerdictForTesting()
}
import { buildCodexManagedHook, getCodexManagedHookInstallMaterial } from './codex-hook-definition'

// Why this file: every Orca instance and build on one HOME shares ~/.codex. The
// frozen command makes their bytes identical, launches only add a missing
// entry, and only app start converts an older build's entry, once.

const homes = setupCodexHookHomes(homedirMock, getPathMock)
const USER_HOOK: HookDefinition = { hooks: [{ type: 'command', command: 'user-hook.sh' }] }

type HooksFile = { hooks: Record<string, HookDefinition[]> }

function hooksPath(): string {
  return join(homes.tmpHome, '.codex', 'hooks.json')
}

function configPath(): string {
  return join(homes.tmpHome, '.codex', 'config.toml')
}

function writeHooks(file: HooksFile): string {
  mkdirSync(join(homes.tmpHome, '.codex'), { recursive: true })
  const raw = `${JSON.stringify(file, null, 2)}\n`
  writeFileSync(hooksPath(), raw)
  return raw
}

function readHooks(): HooksFile {
  return JSON.parse(readFileSync(hooksPath(), 'utf-8'))
}

function fileIdentity(path: string): { raw: string; ino: number; mtimeMs: number } {
  const stat = statSync(path)
  return { raw: readFileSync(path, 'utf-8'), ino: stat.ino, mtimeMs: stat.mtimeMs }
}

/** What the build before the frozen command wrote, appended after the user's hooks. */
function olderBuildCommand(): string {
  const script = join(
    homes.tmpHome,
    '.orca',
    'agent-hooks',
    process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
  )
  return process.platform === 'win32' ? script : wrapPosixHookCommand(script)
}

function everyEvent(command: string): HooksFile {
  const { events } = getCodexManagedHookInstallMaterial()
  return {
    hooks: Object.fromEntries(
      events.map((event) => [
        event,
        [USER_HOOK, { hooks: [buildCodexManagedHook(command, event)] }]
      ])
    )
  }
}

/** Codex's own grant: trusts what it lists as untrusted, and counts real trust writes. */
function installCodexLikeGrant(): { sessions: number; trustWrites: number } {
  const counts = { sessions: 0, trustWrites: 0 }
  grantInternals.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
    counts.sessions += 1
    const trust = readHookTrustEntries(configPath())
    const entries = request.expectedTrustKeys.map((key) => {
      const entry = { ...parseTrustKey(key)!, command: request.managedCommand, timeoutSec: 10 }
      return { key, entry, trustedHash: computeTrustedHash(entry) }
    })
    const untrusted = entries.filter(
      ({ key, trustedHash }) => trust.get(key)?.trustedHash !== trustedHash
    )
    if (untrusted.length > 0) {
      counts.trustWrites += 1
      upsertHookTrustEntries(
        configPath(),
        untrusted.map(({ entry, trustedHash }) => ({ ...entry, trustedHash }))
      )
    }
    return {
      outcome: 'granted' as const,
      wroteTrust: untrusted.length > 0,
      entries: entries.map(({ key, trustedHash }) => ({
        key,
        normalizedKey: normalizeHookTrustKeyForLookup(key),
        trustedHash
      }))
    }
  })
  return counts
}

function ensure(
  writePolicy: RealHomeCodexHookWritePolicy,
  userDataPath = homes.userDataDir
): ReturnType<typeof ensureRealHomeCodexHookState> {
  return ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath, writePolicy })
}

describe('the frozen real-home Codex entry', () => {
  it('converts an older build entry once at app start: one .bak and one trust write', async () => {
    resolveCodexCommandMock.mockReturnValue(process.execPath)
    const counts = installCodexLikeGrant()
    const olderRaw = writeHooks(everyEvent(olderBuildCommand()))
    const { command } = getCodexManagedHookInstallMaterial()

    expect(await ensure('convert-older-forms')).toBe('installed')
    const converted = fileIdentity(hooksPath())
    expect(converted.raw).toBe(`${JSON.stringify(everyEvent(command), null, 2)}\n`)
    expect(readFileSync(`${hooksPath()}.bak`, 'utf-8')).toBe(olderRaw)

    for (const policy of ['add-missing-only', 'add-missing-only', 'convert-older-forms'] as const) {
      realHomeInternals.resetForTesting('pending')
      expect(await ensure(policy)).toBe('installed')
    }

    expect(fileIdentity(hooksPath())).toEqual(converted)
    expect(readFileSync(`${hooksPath()}.bak`, 'utf-8')).toBe(olderRaw)
    expect(counts).toEqual({ sessions: 1, trustWrites: 1 })
  })

  it('writes identical bytes from a second Orca instance, which writes nothing', async () => {
    resolveCodexCommandMock.mockReturnValue(process.execPath)
    const counts = installCodexLikeGrant()
    writeHooks({ hooks: { Stop: [USER_HOOK] } })
    expect(await ensure('convert-older-forms')).toBe('installed')
    const first = fileIdentity(hooksPath())
    const secondUserData = mkdtempSync(join(tmpdir(), 'orca-codex-second-instance-'))

    try {
      realHomeInternals.resetForTesting('pending')
      expect(await ensure('convert-older-forms', secondUserData)).toBe('installed')
      expect(await ensure('add-missing-only', secondUserData)).toBe('installed')
    } finally {
      rmSync(secondUserData, { recursive: true, force: true })
    }

    expect(fileIdentity(hooksPath())).toEqual(first)
    expect(counts.trustWrites).toBe(1)
  })

  it("leaves an older build's entry on a launch, with no write and no trust session", async () => {
    resolveCodexCommandMock.mockReturnValue(process.execPath)
    const counts = installCodexLikeGrant()
    writeHooks(everyEvent(olderBuildCommand()))
    const before = fileIdentity(hooksPath())

    expect(await ensure('add-missing-only')).toBe('installed')

    expect(fileIdentity(hooksPath())).toEqual(before)
    expect(existsSync(`${hooksPath()}.bak`)).toBe(false)
    expect(counts.sessions).toBe(0)
  })

  it('adds the entry on a launch only to the event that lost it', async () => {
    resolveCodexCommandMock.mockReturnValue(process.execPath)
    installCodexLikeGrant()
    const { command } = getCodexManagedHookInstallMaterial()
    const frozen = everyEvent(command)
    frozen.hooks.Stop = [USER_HOOK]
    writeHooks(frozen)

    expect(await ensure('add-missing-only')).toBe('installed')

    const after = readHooks()
    expect(after.hooks.Stop).toEqual([
      USER_HOOK,
      { hooks: [{ type: 'command', command, timeout: 10 }] }
    ])
    for (const [event, definitions] of Object.entries(frozen.hooks)) {
      if (event !== 'Stop') {
        expect(after.hooks[event]).toEqual(definitions)
      }
    }
  })

  it.each(['add-missing-only', 'convert-older-forms'] as const)(
    'never rewrites a newer form or appends beside it (%s)',
    async (policy) => {
      resolveCodexCommandMock.mockReturnValue(process.execPath)
      const counts = installCodexLikeGrant()
      const newer = `: orca-agent-hook-form=2; /bin/sh "\${HOME-}/.orca/agent-hooks/${
        process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
      }"`
      writeHooks(everyEvent(newer))
      const before = fileIdentity(hooksPath())

      expect(await ensure(policy)).toBe('installed')

      expect(fileIdentity(hooksPath())).toEqual(before)
      expect(counts.sessions).toBe(0)
    }
  )

  it.each(['add-missing-only', 'convert-older-forms'] as const)(
    'keeps Orca entries in events this build does not subscribe to (%s)',
    async (policy) => {
      resolveCodexCommandMock.mockReturnValue(process.execPath)
      installCodexLikeGrant()
      const { command } = getCodexManagedHookInstallMaterial()
      const file = everyEvent(command)
      const newerBuildEvent = [{ hooks: [{ type: 'command' as const, command, timeout: 10 }] }]
      file.hooks.PreCompact = newerBuildEvent
      writeHooks(file)

      expect(await ensure(policy)).toBe('installed')

      expect(readHooks().hooks.PreCompact).toEqual(newerBuildEvent)
    }
  )
})
