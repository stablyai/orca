import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { wrapPosixHookCommand, type HookDefinition } from '../agent-hooks/installer-utils'
import { _internals as grantInternals } from './codex-hook-trust-grant'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import {
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
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
  ensureRealHomeCodexHookState as startRealHomeCodexHookEnsure
} from './codex-real-home-hook-install'

/** The lane once Codex's background approval, if any, has settled. */
async function ensureRealHomeCodexHookState(
  args: Parameters<typeof startRealHomeCodexHookEnsure>[0]
): ReturnType<typeof startRealHomeCodexHookEnsure> {
  await startRealHomeCodexHookEnsure(args)
  return realHomeInternals.settledVerdictForTesting()
}

// Why this file (QA case 9): a trust session that fails while someone else edits
// ~/.codex must keep that edit in both files, and must leave no Orca entry that
// Codex would list as "needs review".

const homes = setupCodexHookHomes(homedirMock, getPathMock)
afterEach(() => {
  vi.useRealTimers()
})
beforeEach(() => {
  realHomeInternals.resetForTesting('pending')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
const USER_HOOK: HookDefinition = { hooks: [{ type: 'command', command: 'user-hook.sh' }] }
const SAVED_HOOK: HookDefinition = { hooks: [{ type: 'command', command: 'saved-meanwhile.sh' }] }
const SAVED_PROJECT = '\n[projects."/work/saved-meanwhile"]\ntrust_level = "trusted"\n'

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

function seed(file: HooksFile): void {
  mkdirSync(join(homes.tmpHome, '.codex'), { recursive: true })
  writeFileSync(hooksPath(), `${JSON.stringify(file, null, 2)}\n`)
  writeFileSync(configPath(), 'model = "user-model"\n')
}

const SAVED_HOOK_HASH = 'sha256:approved-in-codex'

function savedHookAt(groupIndex: number): CodexTrustEntry {
  return {
    sourcePath: hooksPath(),
    eventLabel: 'stop',
    groupIndex,
    handlerIndex: 0,
    command: 'saved-meanwhile.sh'
  }
}

/** Codex fails the session after another writer saved both files meanwhile. */
function failSessionAfterConcurrentEdits(): { sessions: number } {
  const counts = { sessions: 0 }
  grantInternals.setGrantSessionRunner(async () => {
    counts.sessions += 1
    const hooks = readHooks()
    hooks.hooks.Stop = [...(hooks.hooks.Stop ?? []), SAVED_HOOK]
    writeFileSync(hooksPath(), `${JSON.stringify(hooks, null, 2)}\n`)
    appendFileSync(configPath(), SAVED_PROJECT)
    // Why: the user approves the saved hook in Codex while the session runs.
    upsertHookTrustEntries(configPath(), [
      { ...savedHookAt(hooks.hooks.Stop.length - 1), trustedHash: SAVED_HOOK_HASH }
    ])
    throw new Error('codex app-server exited with code 1')
  })
  return counts
}

function untrustedOrcaHandlers(): string[] {
  const trust = readHookTrustEntries(configPath())
  const untrusted: string[] = []
  for (const [event, definitions] of Object.entries(readHooks().hooks)) {
    definitions.forEach((definition, groupIndex) => {
      definition.hooks?.forEach((hook, handlerIndex) => {
        if (!isCodexManagedCommand(hook.command)) {
          return
        }
        const entry = createCodexHookTrustEntry(
          hooksPath(),
          event,
          groupIndex,
          handlerIndex,
          definition,
          hook
        )
        if (
          !entry ||
          trust.get(computeTrustKey(entry))?.trustedHash !== computeTrustedHash(entry)
        ) {
          untrusted.push(`${event}:${groupIndex}:${handlerIndex}`)
        }
      })
    })
  }
  return untrusted
}

describe('a failed real-home trust session with a concurrent edit', () => {
  it('keeps the concurrent edits to both files and leaves no untrusted Orca entry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    resolveCodexCommandMock.mockReturnValue(process.execPath)
    seed({ hooks: { Stop: [USER_HOOK] } })
    const counts = failSessionAfterConcurrentEdits()

    expect(
      await ensureRealHomeCodexHookState({
        hooksEnabled: true,
        userDataPath: homes.userDataDir,
        writePolicy: 'add-missing-only'
      })
    ).toBe('unavailable')

    expect(readHooks().hooks.Stop).toEqual([USER_HOOK, SAVED_HOOK])
    expect(readFileSync(configPath(), 'utf-8')).toContain(SAVED_PROJECT)
    expect(untrustedOrcaHandlers()).toEqual([])
    // Why: withdrawing Orca's entry moved the saved hook up a slot; its approval moved too.
    const trust = readHookTrustEntries(configPath())
    expect(trust.get(computeTrustKey(savedHookAt(1)))?.trustedHash).toBe(SAVED_HOOK_HASH)
    expect(trust.get(computeTrustKey(savedHookAt(2)))).toBeUndefined()
    // Why: the log says what happened, including when the next try comes.
    const events = getCodexManagedHookInstallMaterial().events.length
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      `[codex-real-home-hooks] Codex did not approve Orca's entry (error); withdrew ${events} ` +
        'unapproved entries this attempt added; managed lane kept, retrying in 10 s'
    )

    vi.setSystemTime(Date.now() + 10_001)
    await ensureRealHomeCodexHookState({
      hooksEnabled: true,
      userDataPath: homes.userDataDir,
      writePolicy: 'add-missing-only'
    })
    expect(counts.sessions).toBe(2)
  })

  it.skipIf(process.platform === 'win32')(
    'puts back the older entry a failed app-start conversion replaced, keeping the edits',
    async () => {
      resolveCodexCommandMock.mockReturnValue(process.execPath)
      const older = wrapPosixHookCommand(
        join(homes.tmpHome, '.orca', 'agent-hooks', 'codex-hook.sh')
      )
      const olderGroup: HookDefinition = {
        hooks: [{ type: 'command', command: older, timeout: 10 }]
      }
      seed({ hooks: { Stop: [USER_HOOK, olderGroup] } })
      failSessionAfterConcurrentEdits()

      expect(
        await ensureRealHomeCodexHookState({
          hooksEnabled: true,
          userDataPath: homes.userDataDir,
          writePolicy: 'convert-older-forms'
        })
      ).toBe('unavailable')

      expect(readHooks().hooks.Stop).toEqual([USER_HOOK, olderGroup, SAVED_HOOK])
      expect(readFileSync(configPath(), 'utf-8')).toContain(SAVED_PROJECT)
    }
  )
})
