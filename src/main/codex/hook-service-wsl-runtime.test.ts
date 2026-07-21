import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, win32 as pathWin32 } from 'node:path'

import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'
import {
  computeTrustKey,
  computeTrustedHash,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import {
  _internals,
  createCodexWslRuntimeHookInstallPlan,
  type CodexWslRuntimeHookInstallPlan
} from './hook-service'
import type { CodexHookTrustGrantRequest } from './codex-app-server-client'
import { codexAppServerCapabilityCache } from './codex-app-server-capability-cache'
import { _internals as trustGrantInternals } from './codex-hook-trust-grant'

type HooksConfig = {
  hooks: Record<string, { hooks?: { command?: string }[] }[]>
}

const managedEvents = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop'
] as const

let tempRoots: string[] = []

afterEach(() => {
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
  return `if [ -f '${scriptPath}' ] && [ -r '${scriptPath}' ]; then /bin/sh '${scriptPath}'; else cat >/dev/null 2>&1 || :; fi`
}

describe('Codex WSL runtime hook install', () => {
  it('plans WSL hook files with Linux command and trust paths', () => {
    const runtimeHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'

    expect(
      createCodexWslRuntimeHookInstallPlan(runtimeHome, undefined, (_distro, path) => path)
    ).toEqual({
      configPath: pathWin32.join(runtimeHome, 'hooks.json'),
      tomlPath: pathWin32.join(runtimeHome, 'config.toml'),
      scriptPath: pathWin32.join(runtimeHome, '.orca', 'agent-hooks', 'codex-hook.sh'),
      commandScriptPath:
        '/home/alice/.local/share/orca/codex-runtime-home/home/.orca/agent-hooks/codex-hook.sh',
      trustConfigPath: '/home/alice/.local/share/orca/codex-runtime-home/home/hooks.json',
      wslDistro: 'Ubuntu',
      linuxRuntimeHome: '/home/alice/.local/share/orca/codex-runtime-home/home'
    })
  })

  it('plans WSL hooks when the distro home is mounted on a Windows drive', () => {
    const runtimeHome = 'D:\\wsl-home\\.local\\share\\orca\\codex-runtime-home\\home'

    expect(
      createCodexWslRuntimeHookInstallPlan(
        runtimeHome,
        { runtime: 'wsl', wslDistro: 'Ubuntu' },
        (_distro, path) => path
      )
    ).toEqual({
      configPath: pathWin32.join(runtimeHome, 'hooks.json'),
      tomlPath: pathWin32.join(runtimeHome, 'config.toml'),
      scriptPath: pathWin32.join(runtimeHome, '.orca', 'agent-hooks', 'codex-hook.sh'),
      commandScriptPath:
        '/mnt/d/wsl-home/.local/share/orca/codex-runtime-home/home/.orca/agent-hooks/codex-hook.sh',
      trustConfigPath: '/mnt/d/wsl-home/.local/share/orca/codex-runtime-home/home/hooks.json',
      wslDistro: 'Ubuntu',
      linuxRuntimeHome: '/mnt/d/wsl-home/.local/share/orca/codex-runtime-home/home'
    })
  })

  it('uses WSL-canonical paths for hook commands and trust keys', () => {
    const runtimeHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\alias\\.local\\share\\orca\\codex-runtime-home\\home'
    const canonicalHome = '/home/alice/.local/share/orca/codex-runtime-home/home'

    const plan = createCodexWslRuntimeHookInstallPlan(
      runtimeHome,
      { runtime: 'wsl', wslDistro: 'Ubuntu' },
      (distro, linuxPath) => {
        expect(distro).toBe('Ubuntu')
        expect(linuxPath).toBe('/home/alias/.local/share/orca/codex-runtime-home/home')
        return canonicalHome
      }
    )

    expect(plan?.commandScriptPath).toBe(`${canonicalHome}/.orca/agent-hooks/codex-hook.sh`)
    expect(plan?.trustConfigPath).toBe(`${canonicalHome}/hooks.json`)
    expect(plan?.configPath).toBe(pathWin32.join(runtimeHome, 'hooks.json'))
  })

  it('removes managed trust when the WSL canonical path changes', () => {
    const plan = createTestPlan()
    writeFileSync(plan.configPath, '{"hooks":{}}\n', 'utf-8')
    writeFileSync(plan.tomlPath, '', 'utf-8')

    const oldPlan = {
      ...plan,
      commandScriptPath: '/old/home/.orca/agent-hooks/codex-hook.sh',
      trustConfigPath: '/old/home/hooks.json'
    }
    expect(_internals.installManagedHooksIntoWslRuntime(oldPlan).state).toBe('installed')
    const oldCommand = expectedManagedCommand(oldPlan.commandScriptPath)
    const oldKey = computeTrustKey(getManagedTrustEntry(oldPlan, oldCommand))

    const newPlan = {
      ...plan,
      commandScriptPath: '/new/home/.orca/agent-hooks/codex-hook.sh',
      trustConfigPath: '/new/home/hooks.json'
    }
    expect(_internals.installManagedHooksIntoWslRuntime(newPlan).state).toBe('installed')
    const newCommand = expectedManagedCommand(newPlan.commandScriptPath)
    const newKey = computeTrustKey(getManagedTrustEntry(newPlan, newCommand))
    const trustEntries = readHookTrustEntries(plan.tomlPath)

    expect(trustEntries.has(oldKey)).toBe(false)
    expect(trustEntries.has(newKey)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'drains stdin when the WSL runtime script is missing',
    () => {
      const basePlan = createTestPlan()
      const plan = {
        ...basePlan,
        commandScriptPath: join(dirname(basePlan.configPath), 'missing-codex-hook.sh')
      }
      writeFileSync(plan.configPath, '{"hooks":{}}\n', 'utf-8')
      writeFileSync(plan.tomlPath, '', 'utf-8')

      expect(_internals.installManagedHooksIntoWslRuntime(plan).state).toBe('installed')
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

  it('sweeps all managed WSL trust for disable or confirmed absence', () => {
    // Why: disable and confirmed absence intentionally pass []. Transient
    // unavailability must NOT use this path — last known-good trust remains.
    const plan = createTestPlan()
    writeFileSync(plan.configPath, '{"hooks":{}}\n', 'utf-8')
    writeFileSync(plan.tomlPath, '', 'utf-8')
    expect(_internals.installManagedHooksIntoWslRuntime(plan).state).toBe('installed')

    _internals.removeStaleWslRuntimeManagedHookTrustEntries(plan.tomlPath, [])

    expect(readHookTrustEntries(plan.tomlPath).size).toBe(0)
  })

  it('reconciles only current, conclusive WSL path settlements', () => {
    expect(
      _internals.getWslHookReconciliationAction({
        settlement: { status: 'unavailable' },
        isCurrentGeneration: true,
        installedTrustConfigPath: '/mnt/d/home/hooks.json',
        resolvedTrustConfigPath: null,
        installSucceeded: false
      })
    ).toBe('none')

    expect(
      _internals.getWslHookReconciliationAction({
        settlement: { status: 'missing' },
        isCurrentGeneration: false,
        installedTrustConfigPath: '/mnt/d/home/hooks.json',
        resolvedTrustConfigPath: null,
        installSucceeded: false
      })
    ).toBe('none')

    expect(
      _internals.getWslHookReconciliationAction({
        settlement: { status: 'missing' },
        isCurrentGeneration: true,
        installedTrustConfigPath: '/mnt/d/home/hooks.json',
        resolvedTrustConfigPath: null,
        installSucceeded: false
      })
    ).toBe('remove')

    // Why: a `missing` probe right after a verified grant is a false negative;
    // revoking would delete the fresh trust the launching pane reads (#8847).
    expect(
      _internals.getWslHookReconciliationAction({
        settlement: { status: 'missing' },
        isCurrentGeneration: true,
        installedTrustConfigPath: '/mnt/d/home/hooks.json',
        resolvedTrustConfigPath: null,
        installSucceeded: true
      })
    ).toBe('none')

    expect(
      _internals.getWslHookReconciliationAction({
        settlement: { status: 'resolved', canonicalPath: '/windows/d/home' },
        isCurrentGeneration: true,
        installedTrustConfigPath: '/windows/d/home/hooks.json',
        resolvedTrustConfigPath: '/windows/d/home/hooks.json',
        installSucceeded: true
      })
    ).toBe('none')

    // Why: a genuinely moved home resolves to a different path and still
    // reinstalls, even though the original install succeeded.
    expect(
      _internals.getWslHookReconciliationAction({
        settlement: { status: 'resolved', canonicalPath: '/windows/d/home' },
        isCurrentGeneration: true,
        installedTrustConfigPath: '/mnt/d/home/hooks.json',
        resolvedTrustConfigPath: '/windows/d/home/hooks.json',
        installSucceeded: true
      })
    ).toBe('reinstall')
  })

  it('generates a POSIX hook that bridges WSL loopback failures through Windows curl', () => {
    const script = _internals.getManagedScript('posix')
    expect(script).toContain('load_hook_endpoint()')
    expect(script).toContain('"set ORCA_AGENT_HOOK_TOKEN="*)')
    expect(script).toContain('post_codex_hook()')
    expect(script).toContain('is_wsl_runtime()')
    expect(script).toContain('WSL_DISTRO_NAME')
    expect(script).toContain('windows_curl=$(command -v curl.exe 2>/dev/null || true)')
    expect(script).toContain('--data-urlencode "payload@-"')
    expect(script).toContain('if post_codex_hook curl >/dev/null 2>&1; then')
    expect(script).toContain('post_codex_hook "$windows_curl" 3 5 >/dev/null 2>&1 || true')
  })

  it.skipIf(process.platform === 'win32')(
    'refreshes stale hook coordinates from a Windows endpoint file',
    () => {
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
          ORCA_TEST_CAPTURE: capturePath
        }
      })

      expect(result.status).toBe(0)
      const posted = readFileSync(capturePath, 'utf-8')
      expect(posted).toContain('http://127.0.0.1:43210/hook/codex')
      expect(posted).toContain('X-Orca-Agent-Hook-Token: fresh-token')
      expect(posted).not.toContain('stale-token')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'uses the Windows curl discovered from the WSL PATH after loopback fails',
    () => {
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
          ORCA_TEST_CAPTURE: capturePath
        }
      })

      expect(result.status).toBe(0)
      const posted = readFileSync(capturePath, 'utf-8')
      expect(posted).toContain('http://127.0.0.1:43210/hook/codex')
      expect(posted).toContain('X-Orca-Agent-Hook-Token: token')
    }
  )

  it('installs trusted WSL hooks and removes only Orca entries when disabled', () => {
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

    expect(_internals.installManagedHooksIntoWslRuntime(plan).state).toBe('installed')

    const installed = JSON.parse(readFileSync(plan.configPath, 'utf-8')) as HooksConfig
    expect(Object.keys(installed.hooks).sort()).toEqual([...managedEvents].sort())
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
    trustGrantInternals.setGrantSessionRunnerSync(null)
    trustGrantInternals.resetDiagnostics()
    codexAppServerCapabilityCache.clear()
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
  })

  it('grants WSL managed trust through codex inside the distro instead of self-computed writes', () => {
    const plan = createTestPlan()
    writeFileSync(plan.configPath, '{"hooks":{}}\n', 'utf-8')
    writeFileSync(plan.tomlPath, '', 'utf-8')

    const runner = vi.fn((request: CodexHookTrustGrantRequest) => {
      // Simulate codex's side: write trusted_hash blocks the way its config
      // writer would, then report the entries trusted.
      upsertHookTrustEntries(
        plan.tomlPath,
        request.expectedTrustKeys.map((key) => ({
          sourcePath: plan.trustConfigPath,
          eventLabel: key.split(':').at(-3) as CodexTrustEntry['eventLabel'],
          groupIndex: 0,
          handlerIndex: 0,
          command: request.managedCommand,
          trustedHash: `sha256:codex-${key.split(':').at(-3)}`
        }))
      )
      return {
        outcome: 'granted' as const,
        wroteTrust: true,
        entries: request.expectedTrustKeys.map((key) => ({
          key,
          normalizedKey: normalizeHookTrustKeyForLookup(key),
          trustedHash: `sha256:codex-${key.split(':').at(-3)}`
        }))
      }
    })
    trustGrantInternals.setGrantSessionRunnerSync(runner)

    expect(_internals.installManagedHooksIntoWslRuntime(plan).state).toBe('installed')

    expect(runner).toHaveBeenCalledTimes(1)
    const request = runner.mock.calls[0]![0]!
    expect(request.invocation.command).toBe('wsl.exe')
    expect(request.invocation.args.slice(0, 2)).toEqual(['-d', 'Ubuntu'])
    expect(request.hooksListCwd).toBe(plan.linuxRuntimeHome)

    const command = expectedManagedCommand(plan.commandScriptPath)
    const managedTrustEntry = getManagedTrustEntry(plan, command)
    const trustEntries = readHookTrustEntries(plan.tomlPath)
    // Why: the codex-granted hash must be authoritative — the self-computed
    // hash must not overwrite it after a successful grant.
    expect(trustEntries.get(computeTrustKey(managedTrustEntry))?.trustedHash).toBe(
      'sha256:codex-user_prompt_submit'
    )
    expect(trustEntries.get(computeTrustKey(managedTrustEntry))?.trustedHash).not.toBe(
      computeTrustedHash(managedTrustEntry)
    )
  })

  it('keeps the unchanged self-computed lane when the WSL grant falls back', () => {
    const plan = createTestPlan()
    writeFileSync(plan.configPath, '{"hooks":{}}\n', 'utf-8')
    writeFileSync(plan.tomlPath, '', 'utf-8')

    const runner = vi.fn(() => {
      throw new Error('wsl.exe not reachable')
    })
    trustGrantInternals.setGrantSessionRunnerSync(runner)

    expect(_internals.installManagedHooksIntoWslRuntime(plan).state).toBe('installed')

    expect(runner).toHaveBeenCalledTimes(1)
    const command = expectedManagedCommand(plan.commandScriptPath)
    const managedTrustEntry = getManagedTrustEntry(plan, command)
    expect(readHookTrustEntries(plan.tomlPath).get(computeTrustKey(managedTrustEntry))).toEqual({
      enabled: true,
      trustedHash: computeTrustedHash(managedTrustEntry)
    })
  })

  it('uses the previous ledger to remove stale Codex hashes after a canonical path change', () => {
    const basePlan = createTestPlan()
    writeFileSync(basePlan.configPath, '{"hooks":{}}\n', 'utf-8')
    writeFileSync(basePlan.tomlPath, '', 'utf-8')
    let staleKeyExpectedRemoved: string | null = null
    const runner = vi.fn((request: CodexHookTrustGrantRequest) => {
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
    trustGrantInternals.setGrantSessionRunnerSync(runner)

    const oldPlan = {
      ...basePlan,
      commandScriptPath: '/old/home/.orca/agent-hooks/codex-hook.sh',
      trustConfigPath: '/old/home/hooks.json',
      linuxRuntimeHome: '/old/home'
    }
    expect(_internals.installManagedHooksIntoWslRuntime(oldPlan).state).toBe('installed')
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
    expect(_internals.installManagedHooksIntoWslRuntime(newPlan).state).toBe('installed')
    const newKey = computeTrustKey(
      getManagedTrustEntry(newPlan, expectedManagedCommand(newPlan.commandScriptPath))
    )
    const trustEntries = readHookTrustEntries(basePlan.tomlPath)

    expect(runner).toHaveBeenCalledTimes(2)
    expect(trustEntries.has(oldKey)).toBe(false)
    expect(trustEntries.get(newKey)?.trustedHash).toBe('sha256:codex-verbatim-user_prompt_submit')
  })
})
