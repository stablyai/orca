import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { wrapPosixHookCommand, type HookDefinition } from '../agent-hooks/installer-utils'
import type { CodexHookTrustGrantRequest } from './codex-app-server-client'
import { _internals as grantInternals } from './codex-hook-trust-grant'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import {
  computeTrustedHash,
  normalizeHookTrustKeyForLookup,
  computeTrustKey,
  parseTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries,
  upsertHookTrustEntriesInContent,
  type CodexTrustEntry
} from './config-toml-trust'
import { isCodexManagedCommand, setupCodexHookHomes } from './hook-service-test-harness'

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
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'

// Why this file: Codex keys a hook's trust by its position. Orca's automatic
// writes (add a missing entry, convert an older one, collapse duplicates) must
// leave every user hook at its position with its trust untouched; only an
// explicit opt-out removes an entry.

const homes = setupCodexHookHomes(homedirMock, getPathMock)
const USER_A: HookDefinition = { hooks: [{ type: 'command', command: 'user-a.sh' }] }
const USER_B: HookDefinition = { hooks: [{ type: 'command', command: 'user-b.sh', timeout: 5 }] }
const USER_C: HookDefinition = { hooks: [{ type: 'command', command: 'user-c.sh' }] }

type HooksFile = { hooks: Record<string, HookDefinition[]> }

function hooksPath(): string {
  return join(homes.tmpHome, '.codex', 'hooks.json')
}

function configPath(): string {
  return join(homes.tmpHome, '.codex', 'config.toml')
}

function readHooks(): HooksFile {
  return JSON.parse(readFileSync(hooksPath(), 'utf-8'))
}

function orcaGroup(command: string): HookDefinition {
  return { hooks: [{ type: 'command', command, timeout: 10 }] }
}

function olderCommand(): string {
  return wrapPosixHookCommand(join(homes.tmpHome, '.orca', 'agent-hooks', 'codex-hook.sh'))
}

function frozenCommand(): string {
  return getCodexManagedHookInstallMaterial().command
}

/** Every user handler with its position; Orca's handlers are left out. */
function userHooksByPosition(file: HooksFile): string[] {
  return Object.entries(file.hooks).flatMap(([event, definitions]) =>
    definitions.flatMap((definition, groupIndex) =>
      (definition.hooks ?? []).flatMap((hook, handlerIndex) =>
        isCodexManagedCommand(hook.command)
          ? []
          : [`${event}:${groupIndex}:${handlerIndex}:${hook.command}`]
      )
    )
  )
}

/** Seeds hooks.json, plus config.toml with user trust: A trusted, B disabled, C untrusted. */
function seed(file: HooksFile): string {
  mkdirSync(join(homes.tmpHome, '.codex'), { recursive: true })
  writeFileSync(hooksPath(), `${JSON.stringify(file, null, 2)}\n`)
  const userTrust: CodexTrustEntry[] = []
  for (const [event, definitions] of Object.entries(file.hooks)) {
    definitions.forEach((definition, groupIndex) => {
      definition.hooks?.forEach((hook, handlerIndex) => {
        const entry = createCodexHookTrustEntry(
          hooksPath(),
          event,
          groupIndex,
          handlerIndex,
          definition,
          hook
        )
        if (entry && hook.command === 'user-a.sh') {
          userTrust.push(entry)
        }
        if (entry && hook.command === 'user-b.sh') {
          userTrust.push({ ...entry, enabled: false })
        }
      })
    })
  }
  const userToml = upsertHookTrustEntriesInContent('model = "user-model"\n', userTrust)
  writeFileSync(configPath(), userToml)
  return userToml
}

/** Codex's own grant: trusts the listed Orca keys, writing only those blocks. */
function installCodexLikeGrant(): void {
  grantInternals.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
    const entries = request.expectedTrustKeys.map((key) => {
      const entry = { ...parseTrustKey(key)!, command: request.managedCommand, timeoutSec: 10 }
      return { key, entry, trustedHash: computeTrustedHash(entry) }
    })
    upsertHookTrustEntries(
      configPath(),
      entries.map(({ entry, trustedHash }) => ({ ...entry, trustedHash }))
    )
    return {
      outcome: 'granted' as const,
      wroteTrust: true,
      entries: entries.map(({ key, trustedHash }) => ({
        key,
        normalizedKey: normalizeHookTrustKeyForLookup(key),
        trustedHash
      }))
    }
  })
}

async function expectUserHooksUntouched(
  file: HooksFile,
  policy: RealHomeCodexHookWritePolicy
): Promise<HooksFile> {
  const userToml = seed(file)
  const before = userHooksByPosition(file)

  expect(
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: homes.userDataDir,
      writePolicy: policy
    })
  ).toBe('installed')

  const after = readHooks()
  expect(userHooksByPosition(after)).toEqual(before)
  // Why a prefix: Orca's trust blocks are only ever appended after the user's bytes.
  expect(readFileSync(configPath(), 'utf-8').startsWith(userToml)).toBe(true)
  return after
}

function everyEvent(groups: (command: string) => HookDefinition[]): HooksFile {
  const { events } = getCodexManagedHookInstallMaterial()
  return { hooks: Object.fromEntries(events.map((event) => [event, groups(event)])) }
}

beforeEach(() => {
  realHomeInternals.resetForTesting('pending')
  resolveCodexCommandMock.mockReturnValue(process.execPath)
  installCodexLikeGrant()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe.skipIf(process.platform === 'win32')('user hooks under Orca writes', () => {
  it('keeps positions and trust when a launch appends the missing entry', async () => {
    const after = await expectUserHooksUntouched(
      everyEvent(() => [USER_A, USER_B, USER_C]),
      'add-missing-only'
    )

    expect(after.hooks.Stop).toEqual([USER_A, USER_B, USER_C, orcaGroup(frozenCommand())])
  })

  it('keeps positions and trust when app start converts an older entry in place', async () => {
    const after = await expectUserHooksUntouched(
      everyEvent(() => [USER_A, orcaGroup(olderCommand()), USER_B, USER_C]),
      'convert-older-forms'
    )

    expect(after.hooks.Stop).toEqual([USER_A, orcaGroup(frozenCommand()), USER_B, USER_C])
  })

  it('keeps positions and trust when app start collapses a trailing duplicate', async () => {
    const after = await expectUserHooksUntouched(
      everyEvent(() => [
        USER_A,
        orcaGroup(frozenCommand()),
        USER_B,
        USER_C,
        orcaGroup(frozenCommand())
      ]),
      'convert-older-forms'
    )

    expect(after.hooks.Stop).toEqual([USER_A, orcaGroup(frozenCommand()), USER_B, USER_C])
  })

  it('keeps a duplicate that a user hook follows, and trusts both copies', async () => {
    const file = everyEvent(() => [
      USER_A,
      orcaGroup(frozenCommand()),
      USER_B,
      orcaGroup(frozenCommand()),
      USER_C
    ])

    const after = await expectUserHooksUntouched(file, 'convert-older-forms')

    expect(after).toEqual(file)
    const trust = readHookTrustEntries(configPath())
    for (const groupIndex of [1, 3]) {
      const entry = createCodexHookTrustEntry(
        hooksPath(),
        'Stop',
        groupIndex,
        0,
        after.hooks.Stop![groupIndex]!,
        after.hooks.Stop![groupIndex]!.hooks![0]!
      )!
      expect(trust.get(computeTrustKey(entry))?.trustedHash).toBe(computeTrustedHash(entry))
    }
  })

  it('keeps positions and trust when app start normalizes older duplicates to one entry', async () => {
    const after = await expectUserHooksUntouched(
      everyEvent(() => [
        orcaGroup(olderCommand()),
        USER_A,
        { hooks: [USER_B.hooks![0]!, { type: 'command', command: olderCommand(), timeout: 10 }] },
        USER_C
      ]),
      'convert-older-forms'
    )

    expect(after.hooks.Stop).toEqual([orcaGroup(frozenCommand()), USER_A, USER_B, USER_C])
  })
})
