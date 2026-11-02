import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'
import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from '../agent-hooks/hook-stdin-contract'
import {
  computeTrustKey,
  computeTrustedHash,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { CodexHookService, _internals, type CodexWslRuntimeHookInstallPlan } from './hook-service'
import type { CodexHookTrustGrantRequest } from './app-server/codex-app-server-client'
import { codexAppServerCapabilityCache } from './app-server/codex-app-server-capability-cache'
import { _internals as trustGrantInternals } from './codex-hook-trust-grant'

type HooksConfig = {
  hooks: Record<string, { hooks?: { command?: string }[] }[]>
}

let tempRoots: string[] = []

beforeEach(() => {
  // Isolate the trust ledger from the running app's userData.
  const userData = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-hooks-userdata-'))
  tempRoots.push(userData)
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots = []
})

function createTestPlan(): CodexWslRuntimeHookInstallPlan {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-hooks-'))
  tempRoots.push(root)
  const linuxHome = '/home/alice/.local/share/orca/codex-runtime-home/home'
  return {
    configPath: join(root, 'hooks.json'),
    tomlPath: join(root, 'config.toml'),
    scriptPath: join(root, '.orca', 'agent-hooks', 'codex-hook.sh'),
    commandScriptPath: `${linuxHome}/.orca/agent-hooks/codex-hook.sh`,
    trustConfigPath: `${linuxHome}/hooks.json`,
    wslDistro: 'Ubuntu',
    linuxRuntimeHome: linuxHome
  }
}

function getManagedTrustEntry(
  plan: CodexWslRuntimeHookInstallPlan,
  command: string
): CodexTrustEntry {
  return {
    sourcePath: plan.trustConfigPath,
    eventLabel: 'user_prompt_submit',
    groupIndex: 0,
    handlerIndex: 0,
    command,
    timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
  }
}

function expectedManagedCommand(scriptPath: string): string {
  return `if [ -f '${scriptPath}' ] && [ -r '${scriptPath}' ]; then /bin/sh '${scriptPath}'; else ${POSIX_HOOK_STDIN_DRAIN_COMMAND}; fi`
}

describe('Codex WSL runtime hook install', () => {
  it('coalesces launch installs for one home without blocking independent homes', async () => {
    const service = new CodexHookService()
    const releases: (() => void)[] = []
    const started: string[] = []
    vi.spyOn(service, 'installForRuntimeHome').mockImplementation(async (runtimeHomePath) => {
      if (!runtimeHomePath) {
        throw new Error('expected a runtime home')
      }
      started.push(runtimeHomePath)
      await new Promise<void>((resolve) => releases.push(resolve))
      return {
        agent: 'codex',
        state: 'installed',
        configPath: `${runtimeHomePath}\\hooks.json`,
        managedHooksPresent: true,
        detail: null
      }
    })
    const firstHome = '\\\\wsl$\\Ubuntu\\home\\Alice\\.codex'
    const alias = firstHome.replace('\\\\wsl$', '\\\\wsl.localhost')
    const independent = firstHome.replace('\\Alice\\', '\\Bob\\')
    const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }

    const first = service.prepareRuntimeHomeForLaunch(firstHome, target, () => true, false)
    const second = service.prepareRuntimeHomeForLaunch(alias, target, () => true, false)
    const third = service.prepareRuntimeHomeForLaunch(independent, target, () => true, false)
    await vi.waitFor(() => expect(started).toEqual([firstHome, independent]))

    releases.splice(0).forEach((release) => release())
    await Promise.all([first, second, third])
    expect(started).toEqual([firstHome, independent])
  })

  it('does not coalesce one drive-backed home across WSL distros', async () => {
    const service = new CodexHookService()
    const started: string[] = []
    vi.spyOn(service, 'installForRuntimeHome').mockImplementation(async (_runtimeHome, target) => {
      started.push(target?.wslDistro ?? '')
      return null
    })
    const home = 'D:\\wsl-home\\.local\\share\\orca\\codex-runtime-home\\home'

    await Promise.all([
      service.installForRuntimeHomeSerialized(home, { runtime: 'wsl', wslDistro: 'Ubuntu' }),
      service.installForRuntimeHomeSerialized(home, { runtime: 'wsl', wslDistro: 'Debian' })
    ])

    expect(started).toEqual(['Ubuntu', 'Debian'])
  })

  it('keeps case-distinct Linux runtime homes on separate queues', async () => {
    const service = new CodexHookService()
    const started: string[] = []
    vi.spyOn(service, 'installForRuntimeHome').mockImplementation(async (runtimeHomePath) => {
      started.push(runtimeHomePath!)
      return null
    })
    const upper =
      '\\\\wsl.localhost\\Ubuntu\\home\\Alice\\.local\\share\\orca\\codex-runtime-home\\home'
    const lower = upper.replace('\\Alice\\', '\\alice\\')

    await Promise.all([
      service.installForRuntimeHomeSerialized(upper),
      service.installForRuntimeHomeSerialized(lower)
    ])

    expect(started).toEqual([upper, lower])
  })

  it.skipIf(process.platform === 'win32')(
    'drains stdin when the WSL runtime script is missing',
    async () => {
      const basePlan = createTestPlan()
      const plan = {
        ...basePlan,
        commandScriptPath: join(dirname(basePlan.configPath), 'missing-codex-hook.sh')
      }
      writeFileSync(plan.configPath, '{"hooks":{}}\n', 'utf-8')
      writeFileSync(plan.tomlPath, '', 'utf-8')

      expect((await _internals.installManagedHooksIntoWslRuntime(plan))?.state).toBe('installed')
      const installed = JSON.parse(readFileSync(plan.configPath, 'utf-8')) as HooksConfig
      const command = installed.hooks.UserPromptSubmit[0]?.hooks?.[0]?.command
      expect(command).toBe(expectedManagedCommand(plan.commandScriptPath))

      const result = spawnSync('/bin/sh', ['-c', command!], {
        input: Buffer.alloc(1_000_000, 'x')
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refreshes stale hook coordinates from a Windows endpoint file',
    async () => {
      const plan = createTestPlan()
      const root = dirname(plan.configPath)
      const endpointPath = join(root, 'endpoint.cmd')
      const binDir = join(root, 'bin')
      const curlPath = join(binDir, 'curl')
      const capturePath = join(root, 'curl-args.txt')
      mkdirSync(binDir, { recursive: true })
      writeFileSync(
        endpointPath,
        [
          'set ORCA_AGENT_HOOK_PORT=43210',
          'set ORCA_AGENT_HOOK_TOKEN=fresh-token',
          'set ORCA_AGENT_HOOK_ENV=development',
          'set ORCA_AGENT_HOOK_VERSION=1',
          'set ORCA_AGENT_HOOK_TRANSPORT=raw-json-v1',
          ''
        ].join('\r\n'),
        'utf-8'
      )
      writeFileSync(
        curlPath,
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$ORCA_TEST_CAPTURE"\ncat >> "$ORCA_TEST_CAPTURE"\n',
        'utf-8'
      )
      chmodSync(curlPath, 0o755)
      mkdirSync(dirname(plan.scriptPath), { recursive: true })
      writeFileSync(plan.scriptPath, _internals.getManagedScript('posix'), 'utf-8')

      const result = spawnSync('/bin/sh', [plan.scriptPath], {
        encoding: 'utf-8',
        input: '{"hook_event_name":"UserPromptSubmit","prompt":"restart"}',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          ORCA_AGENT_HOOK_ENDPOINT: endpointPath,
          ORCA_AGENT_HOOK_PORT: '1',
          ORCA_AGENT_HOOK_TOKEN: 'stale-token',
          ORCA_PANE_KEY: 'pane-1',
          ORCA_TEST_CAPTURE: capturePath,
          CLAUDE_JOB_DIR: ''
        }
      })

      expect(result.status).toBe(0)
      const posted = readFileSync(capturePath, 'utf-8')
      expect(posted).toContain('http://127.0.0.1:43210/hook/codex')
      expect(posted).toContain('X-Orca-Agent-Hook-Token: fresh-token')
      expect(posted).toContain('Content-Type: application/json')
      expect(posted).not.toContain('stale-token')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses the Windows curl discovered from the WSL PATH after loopback fails',
    async () => {
      const plan = createTestPlan()
      const root = dirname(plan.configPath)
      const binDir = join(root, 'bin')
      const capturePath = join(root, 'windows-curl-args.txt')
      mkdirSync(binDir, { recursive: true })
      writeFileSync(join(binDir, 'curl'), '#!/bin/sh\nexit 7\n', 'utf-8')
      writeFileSync(
        join(binDir, 'curl.exe'),
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$ORCA_TEST_CAPTURE"\ncat >> "$ORCA_TEST_CAPTURE"\n',
        'utf-8'
      )
      chmodSync(join(binDir, 'curl'), 0o755)
      chmodSync(join(binDir, 'curl.exe'), 0o755)
      mkdirSync(dirname(plan.scriptPath), { recursive: true })
      writeFileSync(plan.scriptPath, _internals.getManagedScript('posix'), 'utf-8')

      const result = spawnSync('/bin/sh', [plan.scriptPath], {
        encoding: 'utf-8',
        input: '{"hook_event_name":"Stop"}',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          WSL_DISTRO_NAME: 'Ubuntu',
          ORCA_AGENT_HOOK_ENDPOINT: '',
          ORCA_AGENT_HOOK_PORT: '43210',
          ORCA_AGENT_HOOK_TOKEN: 'token',
          ORCA_PANE_KEY: 'pane-1',
          ORCA_TEST_CAPTURE: capturePath,
          CLAUDE_JOB_DIR: ''
        }
      })

      expect(result.status).toBe(0)
      const posted = readFileSync(capturePath, 'utf-8')
      expect(posted).toContain('http://127.0.0.1:43210/hook/codex')
      expect(posted).toContain('X-Orca-Agent-Hook-Token: token')
    }
  )

  it('installs trusted WSL hooks and removes only Orca entries when disabled', async () => {
    const plan = createTestPlan()
    const userCommand = '/bin/sh /home/alice/user-hook.sh'
    writeFileSync(
      plan.configPath,
      `${JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: userCommand }] }],
          PreCompact: [
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    "if [ -x '/old/.orca/agent-hooks/codex-hook.sh' ]; then /bin/sh '/old/.orca/agent-hooks/codex-hook.sh'; fi"
                }
              ]
            }
          ]
        }
      })}\n`,
      'utf-8'
    )
    const unrelatedTrustKey = '/home/alice/custom/hooks.json:stop:0:0'
    writeFileSync(
      plan.tomlPath,
      `[hooks.state."${unrelatedTrustKey}"]\nenabled = false\ntrusted_hash = "sha256:user"\n`,
      'utf-8'
    )

    expect((await _internals.installManagedHooksIntoWslRuntime(plan))?.state).toBe('installed')

    const installed = JSON.parse(readFileSync(plan.configPath, 'utf-8')) as HooksConfig
    const managedCommand = installed.hooks.UserPromptSubmit[0]?.hooks?.[0]?.command
    expect(managedCommand).toBe(expectedManagedCommand(plan.commandScriptPath))
    expect(installed.hooks.UserPromptSubmit[1]?.hooks?.[0]?.command).toBe(userCommand)
    expect(readFileSync(plan.scriptPath, 'utf-8')).toContain('command -v curl.exe')

    const managedTrustEntry = getManagedTrustEntry(plan, managedCommand!)
    const trustEntries = readHookTrustEntries(plan.tomlPath)
    expect(trustEntries.get(computeTrustKey(managedTrustEntry))).toEqual({
      enabled: true,
      trustedHash: computeTrustedHash(managedTrustEntry)
    })
    expect(trustEntries.get(unrelatedTrustKey)).toEqual({
      enabled: false,
      trustedHash: 'sha256:user'
    })

    expect(_internals.refreshWslRuntimeUserHooks(plan).state).toBe('not_installed')

    const refreshed = JSON.parse(readFileSync(plan.configPath, 'utf-8')) as HooksConfig
    expect(refreshed.hooks).toEqual({
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: userCommand }] }]
    })
    const refreshedTrustEntries = readHookTrustEntries(plan.tomlPath)
    expect(refreshedTrustEntries.has(computeTrustKey(managedTrustEntry))).toBe(false)
    expect(refreshedTrustEntries.get(unrelatedTrustKey)).toEqual({
      enabled: false,
      trustedHash: 'sha256:user'
    })
  })
})

describe('Codex WSL runtime hook install app-server grant lane', () => {
  let userDataDir: string
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-wsl-grant-userdata-'))
    tempRoots.push(userDataDir)
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = userDataDir
    trustGrantInternals.resetDiagnostics()
    codexAppServerCapabilityCache.clear()
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
  })

  it('keeps the unchanged self-computed lane when the WSL grant falls back', async () => {
    const plan = createTestPlan()
    writeFileSync(plan.configPath, '{"hooks":{}}\n', 'utf-8')
    writeFileSync(plan.tomlPath, '', 'utf-8')

    const runner = vi.fn(() => {
      throw new Error('wsl.exe not reachable')
    })
    trustGrantInternals.setGrantSessionRunner(runner)

    expect((await _internals.installManagedHooksIntoWslRuntime(plan))?.state).toBe('installed')

    expect(runner).toHaveBeenCalledTimes(1)
    const command = expectedManagedCommand(plan.commandScriptPath)
    const managedTrustEntry = getManagedTrustEntry(plan, command)
    expect(readHookTrustEntries(plan.tomlPath).get(computeTrustKey(managedTrustEntry))).toEqual({
      enabled: true,
      trustedHash: computeTrustedHash(managedTrustEntry)
    })
  })

  it('uses the previous ledger to remove stale Codex hashes after a canonical path change', async () => {
    const basePlan = createTestPlan()
    writeFileSync(basePlan.configPath, '{"hooks":{}}\n', 'utf-8')
    writeFileSync(basePlan.tomlPath, '', 'utf-8')
    let staleKeyExpectedRemoved: string | null = null
    const runner = vi.fn(async (request: CodexHookTrustGrantRequest) => {
      if (staleKeyExpectedRemoved) {
        expect(readHookTrustEntries(basePlan.tomlPath).has(staleKeyExpectedRemoved)).toBe(false)
      }
      const entries = request.expectedTrustKeys.map((key) => {
        const parsed = parseTrustKey(key)!
        return {
          sourcePath: parsed.sourcePath,
          eventLabel: parsed.eventLabel,
          groupIndex: parsed.groupIndex,
          handlerIndex: parsed.handlerIndex,
          command: request.managedCommand,
          trustedHash: `sha256:codex-verbatim-${parsed.eventLabel}`
        }
      })
      upsertHookTrustEntries(basePlan.tomlPath, entries)
      return {
        outcome: 'granted' as const,
        wroteTrust: true,
        entries: request.expectedTrustKeys.map((key) => ({
          key,
          normalizedKey: normalizeHookTrustKeyForLookup(key),
          trustedHash: `sha256:codex-verbatim-${parseTrustKey(key)!.eventLabel}`
        }))
      }
    })
    trustGrantInternals.setGrantSessionRunner(runner)

    const oldPlan = {
      ...basePlan,
      commandScriptPath: '/old/home/.orca/agent-hooks/codex-hook.sh',
      trustConfigPath: '/old/home/hooks.json',
      linuxRuntimeHome: '/old/home'
    }
    expect((await _internals.installManagedHooksIntoWslRuntime(oldPlan))?.state).toBe('installed')
    const oldKey = computeTrustKey(
      getManagedTrustEntry(oldPlan, expectedManagedCommand(oldPlan.commandScriptPath))
    )
    staleKeyExpectedRemoved = oldKey

    const newPlan = {
      ...basePlan,
      commandScriptPath: '/new/home/.orca/agent-hooks/codex-hook.sh',
      trustConfigPath: '/new/home/hooks.json',
      linuxRuntimeHome: '/new/home'
    }
    expect((await _internals.installManagedHooksIntoWslRuntime(newPlan))?.state).toBe('installed')
    const newKey = computeTrustKey(
      getManagedTrustEntry(newPlan, expectedManagedCommand(newPlan.commandScriptPath))
    )
    const trustEntries = readHookTrustEntries(basePlan.tomlPath)

    expect(runner).toHaveBeenCalledTimes(2)
    expect(trustEntries.has(oldKey)).toBe(false)
    expect(trustEntries.get(newKey)?.trustedHash).toBe('sha256:codex-verbatim-user_prompt_submit')
  })
})
