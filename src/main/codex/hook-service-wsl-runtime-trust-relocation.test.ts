import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MANAGED_HOOK_TIMEOUT_SECONDS, readHooksJson } from '../agent-hooks/installer-utils'
import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from '../agent-hooks/hook-stdin-contract'
import {
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexEventLabel,
  type CodexTrustEntry
} from './config-toml-trust'
import { _internals, type CodexWslRuntimeHookInstallPlan } from './hook-service'
import { codexAppServerCapabilityCache } from './codex-app-server-capability-cache'
import { _internals as trustGrantInternals } from './codex-hook-trust-grant'

const LINUX_HOME = '/home/alice/.local/share/orca/codex-runtime-home/home'
const CLAUDE_COPY = "/bin/sh '/home/alice/.orca/agent-hooks/claude-hook.sh'"
const USER_HOOK = 'echo user-hook'

let tempRoots: string[] = []
let previousUserDataPath: string | undefined

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

beforeEach(() => {
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = makeTempDir('orca-wsl-trust-relocation-userdata-')
  trustGrantInternals.resetDiagnostics()
  codexAppServerCapabilityCache.clear()
  // Why: take the self-computed fallback lane; no wsl.exe or codex runs in tests.
  trustGrantInternals.setGrantSessionRunner(() => {
    throw new Error('wsl.exe not reachable')
  })
})

afterEach(() => {
  trustGrantInternals.setGrantSessionRunner(null)
  trustGrantInternals.resetDiagnostics()
  codexAppServerCapabilityCache.clear()
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots = []
})

function createTestPlan(): CodexWslRuntimeHookInstallPlan {
  const root = makeTempDir('orca-codex-wsl-trust-relocation-')
  return {
    configPath: join(root, 'hooks.json'),
    tomlPath: join(root, 'config.toml'),
    scriptPath: join(root, '.orca', 'agent-hooks', 'codex-hook.sh'),
    commandScriptPath: `${LINUX_HOME}/.orca/agent-hooks/codex-hook.sh`,
    trustConfigPath: `${LINUX_HOME}/hooks.json`,
    wslDistro: 'Ubuntu',
    linuxRuntimeHome: LINUX_HOME
  }
}

function managedCommand(plan: CodexWslRuntimeHookInstallPlan): string {
  const script = plan.commandScriptPath
  return `if [ -f '${script}' ] && [ -r '${script}' ]; then /bin/sh '${script}'; else ${POSIX_HOOK_STDIN_DRAIN_COMMAND}; fi`
}

function entryAt(
  plan: CodexWslRuntimeHookInstallPlan,
  eventLabel: CodexEventLabel,
  groupIndex: number,
  command: string,
  timeoutSec?: number
): CodexTrustEntry {
  return {
    sourcePath: plan.trustConfigPath,
    eventLabel,
    groupIndex,
    handlerIndex: 0,
    command,
    ...(timeoutSec === undefined ? {} : { timeoutSec })
  }
}

// The round-1 probe layout: Orca's entry, a Claude hook Codex's importer copied, then the user's hook.
function writeProbeLayout(plan: CodexWslRuntimeHookInstallPlan, withCopy: boolean): void {
  const managed = { type: 'command', command: managedCommand(plan), timeout: 10 }
  const copy = { type: 'command', command: CLAUDE_COPY, timeout: 10 }
  const user = { type: 'command', command: USER_HOOK, timeout: 5 }
  const stop = withCopy
    ? [{ hooks: [managed] }, { hooks: [copy] }, { hooks: [user] }]
    : [{ hooks: [managed] }, { hooks: [user] }]
  writeFileSync(plan.configPath, `${JSON.stringify({ hooks: { Stop: stop } })}\n`, 'utf-8')
}

function trustAt(entry: CodexTrustEntry, trustedHash: string, enabled: boolean): CodexTrustEntry {
  return { ...entry, trustedHash, enabled }
}

describe('WSL runtime install keeps the user’s hook approvals when Orca’s entries move them', () => {
  it('carries a trusted user hook to its new key when an imported Claude copy is removed', async () => {
    const plan = createTestPlan()
    writeProbeLayout(plan, true)
    const managedAt0 = entryAt(plan, 'stop', 0, managedCommand(plan), MANAGED_HOOK_TIMEOUT_SECONDS)
    const copyAt1 = entryAt(plan, 'stop', 1, CLAUDE_COPY, 10)
    const userAt2 = entryAt(plan, 'stop', 2, USER_HOOK, 5)
    const userHash = computeTrustedHash(userAt2)
    upsertHookTrustEntries(plan.tomlPath, [
      trustAt(managedAt0, computeTrustedHash(managedAt0), true),
      trustAt(copyAt1, computeTrustedHash(copyAt1), true),
      trustAt(userAt2, userHash, false)
    ])

    expect((await _internals.installManagedHooksIntoWslRuntime(plan)).state).toBe('installed')

    const stop = readHooksJson(plan.configPath)?.hooks?.Stop ?? []
    expect(stop.map((group) => group.hooks?.[0]?.command)).toEqual([
      managedCommand(plan),
      USER_HOOK
    ])
    const trust = readHookTrustEntries(plan.tomlPath)
    expect(trust.get(computeTrustKey({ ...userAt2, groupIndex: 1 }))).toEqual({
      trustedHash: userHash,
      enabled: false
    })
    expect(trust.has(computeTrustKey(userAt2))).toBe(false)
    const hashes = [...trust.values()].map((state) => state.trustedHash)
    expect(hashes).not.toContain(computeTrustedHash(copyAt1))
  })

  it('leaves a user hook whose recorded hash no longer matches it for Codex to review', async () => {
    const plan = createTestPlan()
    writeProbeLayout(plan, true)
    const copyAt1 = entryAt(plan, 'stop', 1, CLAUDE_COPY, 10)
    const userAt2 = entryAt(plan, 'stop', 2, USER_HOOK, 5)
    upsertHookTrustEntries(plan.tomlPath, [
      trustAt(copyAt1, computeTrustedHash(copyAt1), true),
      trustAt(userAt2, 'sha256:edited-since-approval', true)
    ])

    expect((await _internals.installManagedHooksIntoWslRuntime(plan)).state).toBe('installed')

    const trust = readHookTrustEntries(plan.tomlPath)
    expect(trust.has(computeTrustKey({ ...userAt2, groupIndex: 1 }))).toBe(false)
    expect(trust.get(computeTrustKey(userAt2))).toEqual({
      trustedHash: 'sha256:edited-since-approval',
      enabled: true
    })
  })

  it('changes no user approval when no Orca-owned copy was present', async () => {
    const plan = createTestPlan()
    writeProbeLayout(plan, false)
    const userAt1 = entryAt(plan, 'stop', 1, USER_HOOK, 5)
    upsertHookTrustEntries(plan.tomlPath, [trustAt(userAt1, computeTrustedHash(userAt1), false)])
    const before = readHookTrustEntries(plan.tomlPath)

    expect((await _internals.installManagedHooksIntoWslRuntime(plan)).state).toBe('installed')

    const managedKey = computeTrustKey(
      entryAt(plan, 'stop', 0, managedCommand(plan), MANAGED_HOOK_TIMEOUT_SECONDS)
    )
    const after = readHookTrustEntries(plan.tomlPath)
    after.delete(managedKey)
    // Only Orca's own managed entries were added; the user's approval is untouched.
    const isUserKey = (key: string): boolean => key.includes(':stop:1:')
    expect([...after.entries()].filter(([key]) => isUserKey(key))).toEqual([...before.entries()])
    expect(
      [...after.keys()].filter((key) => !isUserKey(key)).every((key) => key.endsWith(':0:0'))
    ).toBe(true)
  })

  it('carries a trusted user hook when Orca’s entry is first prepended ahead of it', async () => {
    const plan = createTestPlan()
    writeFileSync(
      plan.configPath,
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: USER_HOOK, timeout: 5 }] }] } })}\n`,
      'utf-8'
    )
    const userAt0 = entryAt(plan, 'stop', 0, USER_HOOK, 5)
    const userHash = computeTrustedHash(userAt0)
    upsertHookTrustEntries(plan.tomlPath, [trustAt(userAt0, userHash, true)])

    expect((await _internals.installManagedHooksIntoWslRuntime(plan)).state).toBe('installed')

    const managedAt0 = entryAt(plan, 'stop', 0, managedCommand(plan), MANAGED_HOOK_TIMEOUT_SECONDS)
    const trust = readHookTrustEntries(plan.tomlPath)
    expect(trust.get(computeTrustKey({ ...userAt0, groupIndex: 1 }))).toEqual({
      trustedHash: userHash,
      enabled: true
    })
    expect(trust.get(computeTrustKey(managedAt0))).toEqual({
      trustedHash: computeTrustedHash(managedAt0),
      enabled: true
    })
  })
})
