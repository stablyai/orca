import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, win32 as pathWin32 } from 'node:path'

import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'
import {
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import {
  _internals,
  createCodexWslRuntimeHookInstallPlan,
  type CodexWslRuntimeHookInstallPlan
} from './hook-service'

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
    trustConfigPath: `${linuxHome}/hooks.json`
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
      trustConfigPath: '/home/alice/.local/share/orca/codex-runtime-home/home/hooks.json'
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
      trustConfigPath: '/mnt/d/wsl-home/.local/share/orca/codex-runtime-home/home/hooks.json'
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
    expect(managedCommand).toBe(
      `if [ -r '${plan.commandScriptPath}' ]; then /bin/sh '${plan.commandScriptPath}'; fi`
    )
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
