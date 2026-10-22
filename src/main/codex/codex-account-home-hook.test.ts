import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as HashLookup from './codex-hook-hash-lookup'
import type { HookDefinition } from '../agent-hooks/installer-utils'

const mocks = vi.hoisted(() => {
  const hashes: Record<string, string> = {}
  return { homedir: vi.fn<() => string>(), hashes }
})

vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: mocks.homedir
}))
vi.mock('./codex-hook-hash-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof HashLookup>()),
  resolveCodexHookAnswerForLaunch: vi.fn(async () => ({ kind: 'hashes', hashes: mocks.hashes })),
  readEveryKnownCodexHookHashes: vi.fn(() => [mocks.hashes])
}))

import { reconcileCodexAccountHomeHook } from './codex-account-home-hook'
import { CODEX_EVENT_LABEL, getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import {
  getCodexExplicitHomeHookSourcePath,
  readHookTrustEntries,
  upsertHookTrustEntries
} from './config-toml-trust'

const USER_HOOK: HookDefinition = { hooks: [{ type: 'command', command: 'notify-me.sh' }] }

let root: string
let accountHome: string

const hooksJsonPath = (): string => join(accountHome, 'hooks.json')
const tomlPath = (): string => join(accountHome, 'config.toml')

function readHooks(): Record<string, HookDefinition[]> {
  return JSON.parse(readFileSync(hooksJsonPath(), 'utf-8')).hooks
}

function commandsOf(definitions: HookDefinition[] | undefined): string[] {
  return (definitions ?? []).flatMap((definition) =>
    (definition.hooks ?? []).map((hook) => String(hook.command))
  )
}

function userApprovalHashes(): string[] {
  return [...readHookTrustEntries(tomlPath()).values()].flatMap((state) =>
    state.trustedHash === 'sha256:user' ? [state.trustedHash] : []
  )
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-account-home-hook-')))
  const home = join(root, 'home')
  accountHome = join(home, '.local', 'share', 'orca', 'codex-accounts', 'a1', 'home')
  mkdirSync(accountHome, { recursive: true })
  mkdirSync(join(root, 'user-data'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
  vi.stubEnv('CODEX_HOME', '')
  mocks.homedir.mockReturnValue(home)
  mocks.hashes = Object.fromEntries(
    Object.values(CODEX_EVENT_LABEL).map((label) => [label, `sha256:codex-${label}`])
  )
  writeFileSync(hooksJsonPath(), JSON.stringify({ hooks: { Stop: [USER_HOOK] } }))
  upsertHookTrustEntries(tomlPath(), [
    {
      sourcePath: getCodexExplicitHomeHookSourcePath(hooksJsonPath()),
      eventLabel: 'stop',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'notify-me.sh',
      trustedHash: 'sha256:user',
      enabled: true
    }
  ])
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('reconcileCodexAccountHomeHook', () => {
  it("adds Orca's entry beside the account's own hook, keeping its approval", async () => {
    await reconcileCodexAccountHomeHook(accountHome, () => true, true)

    const orcaCommand = getCodexManagedHookInstallMaterial().command
    const hooks = readHooks()
    expect(commandsOf(hooks.Stop)).toEqual(['notify-me.sh', orcaCommand])
    expect(commandsOf(hooks.SessionStart)).toEqual([orcaCommand])
    expect(userApprovalHashes()).toEqual(['sha256:user'])
    const approved = [...readHookTrustEntries(tomlPath()).values()].map((s) => s.trustedHash)
    expect(approved).toContain('sha256:codex-stop')
    // Why: the user's own ~/.codex is not this lane's to touch.
    expect(existsSync(join(root, 'home', '.codex'))).toBe(false)
  })

  it("takes only Orca's entry back out when hooks are turned off", async () => {
    await reconcileCodexAccountHomeHook(accountHome, () => true, false)
    await reconcileCodexAccountHomeHook(accountHome, () => false, false)

    const hooks = readHooks()
    expect(commandsOf(hooks.Stop)).toEqual(['notify-me.sh'])
    expect(hooks.SessionStart).toBeUndefined()
    expect(userApprovalHashes()).toEqual(['sha256:user'])
    const approved = [...readHookTrustEntries(tomlPath()).values()].map((s) => s.trustedHash)
    expect(approved).not.toContain('sha256:codex-stop')
  })

  it('is a no-op on a second launch', async () => {
    await reconcileCodexAccountHomeHook(accountHome, () => true, true)
    const before = readFileSync(hooksJsonPath(), 'utf-8')
    const toml = readFileSync(tomlPath(), 'utf-8')
    await reconcileCodexAccountHomeHook(accountHome, () => true, true)
    expect(readFileSync(hooksJsonPath(), 'utf-8')).toBe(before)
    expect(readFileSync(tomlPath(), 'utf-8')).toBe(toml)
  })
})
