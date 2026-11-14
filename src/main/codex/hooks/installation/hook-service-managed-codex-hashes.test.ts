import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type * as HooksJsonWrite from '../../../agent-hooks/installation/configuration/hooks-json-write'
import type * as TrustDerivation from '../../trust/hooks/codex-hook-trust-derivation'
import { setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock, hooks, codex } = vi.hoisted(() => {
  const hooks: { beforeHooksJsonWrite: (() => void) | null } = { beforeHooksJsonWrite: null }
  return {
    getPathMock: vi.fn<(name: string) => string>(),
    homedirMock: vi.fn<() => string>(),
    hooks,
    codex: {
      fingerprintCodex: vi.fn<(codexPath: string) => string | null>(),
      probeCodexVersion: vi.fn<(codexPath: string) => Promise<string | null>>(),
      deriveCodexHookHashes: vi.fn()
    }
  }
})

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))
vi.mock('../../trust/hooks/codex-hook-trust-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustDerivation>()),
  ...codex
}))
vi.mock(
  '../../../agent-hooks/installation/configuration/hooks-json-write',
  async (importOriginal) => {
    const actual = await importOriginal<typeof HooksJsonWrite>()
    return {
      ...actual,
      writeHooksJson: (...args: Parameters<typeof actual.writeHooksJson>) => {
        hooks.beforeHooksJsonWrite?.()
        return actual.writeHooksJson(...args)
      }
    }
  }
)

import './hook-service'
import { CodexHookService } from './codex-hook-service-implementation'
import { startCodexHookHashLookup } from '../../trust/hooks/codex-hook-hash-lookup'
import type { CodexHookAnswer } from '../../trust/hooks/codex-hook-trust-derivation'
import {
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexEventLabel
} from '../../trust/toml/config-toml-trust'
import {
  computeCodexTrustKey as computeTrustKey,
  getExplicitHomeCodexHookSourcePath as getCodexExplicitHomeHookSourcePath,
  computeCodexTrustedHash as computeTrustedHash
} from '../../trust/identity/codex-trust-identity'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  computeOrcaCodexHookHashes,
  getCodexManagedHookStatusMessage,
  getManagedScriptPath
} from '../definitions/codex-hook-definition'
import { buildCodexHookCommand as getManagedCommand } from '../definitions/codex-hook-command-form'
import { writeCodexTrustGrantLedgerHome } from '../../trust/grants/codex-trust-grant-ledger'
import { getCodexHookTrustSignature } from '../definitions/codex-hook-identity'

const homes = setupCodexHookHomes(homedirMock, getPathMock)
beforeEach(() => {
  startCodexHookHashLookup(Promise.resolve())
})

const CODEX_HASHES = {
  session_start: 'sha256:codex-session_start',
  user_prompt_submit: 'sha256:codex-user_prompt_submit',
  pre_tool_use: 'sha256:codex-pre_tool_use',
  permission_request: 'sha256:codex-permission_request',
  post_tool_use: 'sha256:codex-post_tool_use',
  stop: 'sha256:codex-stop'
}

function managedHome(): string {
  return join(homes.userDataDir, 'codex-runtime-home', 'home')
}

function managedKey(eventLabel: CodexEventLabel, groupIndex: number): string {
  return computeTrustKey({
    sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
    eventLabel,
    groupIndex,
    handlerIndex: 0,
    command: getManagedCommand(getManagedScriptPath())
  })
}

function listedEventApprovals(): Record<string, string | undefined> {
  const trust = readHookTrustEntries(join(managedHome(), 'config.toml'))
  return Object.fromEntries(
    CODEX_EVENTS.map((eventName) => CODEX_EVENT_LABEL[eventName])
      .filter((label) => label in CODEX_HASHES)
      .map((label) => [label, trust.get(managedKey(label, 0))?.trustedHash])
  )
}

function seedSystemUserStopHook(): void {
  const systemHome = join(homes.tmpHome, '.codex')
  mkdirSync(systemHome, { recursive: true })
  writeFileSync(
    join(systemHome, 'hooks.json'),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop.sh' }] }] } })
  )
  upsertHookTrustEntries(join(systemHome, 'config.toml'), [
    {
      sourcePath: join(systemHome, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'user-stop.sh'
    }
  ])
}

let codexBinaries = 0

/** Change the binary fingerprint as well as the answer to simulate an update. */
function useAnswer(answer: CodexHookAnswer | Promise<CodexHookAnswer>): void {
  codexBinaries += 1
  codex.fingerprintCodex.mockReturnValue(`codex-${codexBinaries}`)
  codex.probeCodexVersion.mockResolvedValue(`codex-cli 0.${codexBinaries}.0`)
  codex.deriveCodexHookHashes.mockReturnValue(Promise.resolve(answer))
}

function useCodexHashes(): void {
  useAnswer({ kind: 'hashes', codexVersion: 'codex-cli 0.131.0', hashes: CODEX_HASHES })
}

const timedOut: CodexHookAnswer = { kind: 'pending', failure: 'timed out' }

const command = (): string => getManagedCommand(getManagedScriptPath())

describe('managed-home Codex hook approval', () => {
  it('writes the approval before the entry, and takes it back if the entry write fails', async () => {
    useCodexHashes()
    const approvedAtWrite: (string | undefined)[] = []
    hooks.beforeHooksJsonWrite = () => {
      approvedAtWrite.push(
        readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
          ?.trustedHash
      )
      throw new Error('disk full')
    }
    try {
      expect((await new CodexHookService().install()).state).toBe('error')
    } finally {
      hooks.beforeHooksJsonWrite = null
    }

    expect(approvedAtWrite).toEqual(['sha256:codex-stop'])
    expect(
      readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
    ).toBe(undefined)
  })

  it("keeps the managed config.toml loadable when hooks are off and the user's approvals are inline", async () => {
    const systemHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemHome, { recursive: true })
    const userHook = { type: 'command', command: 'user-stop.sh' }
    writeFileSync(
      join(systemHome, 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [userHook] }] } })
    )
    const userKey = computeTrustKey({
      sourcePath: join(systemHome, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'user-stop.sh'
    })
    const userHash = computeTrustedHash({
      sourcePath: join(systemHome, 'hooks.json'),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'user-stop.sh'
    })
    writeFileSync(
      join(systemHome, 'config.toml'),
      `model = "m"\n[hooks]\nstate = { ${JSON.stringify(userKey)} = { trusted_hash = "${userHash}" } }\n`
    )

    await new CodexHookService().refreshRuntimeUserHooks()

    expect(() => parseToml(readFileSync(join(managedHome(), 'config.toml'), 'utf-8'))).not.toThrow()
  })

  it("lets hooks turned off during a Codex launch's wait win", async () => {
    useCodexHashes()
    const service = new CodexHookService()
    await service.install()
    let enabled = true
    let answer: (value: CodexHookAnswer) => void = () => {}
    useAnswer(new Promise<CodexHookAnswer>((resolve) => (answer = resolve)))
    const launch = service.installForLaunchPrep(undefined, true, () => enabled)
    await vi.waitFor(() => expect(codex.deriveCodexHookHashes).toHaveBeenCalledTimes(2))

    enabled = false
    await service.remove()
    answer({ kind: 'hashes', codexVersion: 'codex-cli 0.131.0', hashes: CODEX_HASHES })
    await launch

    expect(readFileSync(join(managedHome(), 'hooks.json'), 'utf-8')).not.toContain('codex-hook')
    expect(listedEventApprovals().stop).toBeUndefined()
  })

  it("turning hooks off moves the user's mirrored approval back to its own slot", async () => {
    seedSystemUserStopHook()
    useCodexHashes()
    const service = new CodexHookService()
    await service.install()
    const userKey = (groupIndex: number): string =>
      computeTrustKey({
        sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
        eventLabel: 'stop',
        groupIndex,
        handlerIndex: 0,
        command: 'user-stop.sh'
      })
    const userHash = readHookTrustEntries(join(managedHome(), 'config.toml')).get(userKey(1))
    expect(userHash?.trustedHash).toBeDefined()

    await service.remove()

    const trust = readHookTrustEntries(join(managedHome(), 'config.toml'))
    expect(trust.get(userKey(0))?.trustedHash).toBe(userHash?.trustedHash)
    expect(trust.get(userKey(1))).toBeUndefined()
  })

  describe("Orca's own hash until Codex answers, as main wrote it", () => {
    const orcaStop = (): string | undefined => computeOrcaCodexHookHashes().stop ?? undefined

    function stopApproval(): string | undefined {
      return readHookTrustEntries(join(managedHome(), 'config.toml')).get(managedKey('stop', 0))
        ?.trustedHash
    }

    it("keeps the approval main's grant recorded for Orca's entry until Codex answers", async () => {
      useAnswer(timedOut)
      const service = new CodexHookService()
      await service.install()
      const entry = {
        sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
        eventLabel: 'stop' as const,
        groupIndex: 0,
        handlerIndex: 0,
        command: command(),
        timeoutSec: 10,
        statusMessage: getCodexManagedHookStatusMessage(command())
      }
      upsertHookTrustEntries(join(managedHome(), 'config.toml'), [
        { ...entry, trustedHash: 'sha256:main-granted' }
      ])
      writeCodexTrustGrantLedgerHome(managedHome(), {
        binary: null,
        entries: {
          [computeTrustKey(entry)]: {
            signature: getCodexHookTrustSignature(entry),
            trustedHash: 'sha256:main-granted'
          }
        }
      })

      await service.install()

      expect(stopApproval()).toBe('sha256:main-granted')
      expect(service.getStatus(managedHome()).state).toBe('installed')
    })

    it("replaces a user hook's approval left at Orca's key with Orca's hash", async () => {
      useAnswer(timedOut)
      const service = new CodexHookService()
      await service.install()
      // Positional keys can retain a removed user hook's approval at the managed hook's position.
      upsertHookTrustEntries(join(managedHome(), 'config.toml'), [
        {
          sourcePath: getCodexExplicitHomeHookSourcePath(join(managedHome(), 'hooks.json')),
          eventLabel: 'stop',
          groupIndex: 0,
          handlerIndex: 0,
          command: command(),
          trustedHash: 'sha256:user'
        }
      ])

      await service.install()

      expect(stopApproval()).toBe(orcaStop())
    })
  })
})
