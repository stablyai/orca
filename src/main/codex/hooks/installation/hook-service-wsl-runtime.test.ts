import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../../../agent-hooks/installer-utils'
import { POSIX_HOOK_STDIN_DRAIN_COMMAND } from '../../../agent-hooks/hook-stdin-contract'
import { readHookTrustEntries, type CodexTrustEntry } from '../../trust/toml/config-toml-trust'
import {
  computeCodexTrustKey as computeTrustKey,
  computeCodexTrustedHash as computeTrustedHash
} from '../../trust/identity/codex-trust-identity'
import { _internals } from './hook-service'
import type { CodexWslRuntimeHookInstallPlan } from './codex-wsl-hook-install-plan'

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
