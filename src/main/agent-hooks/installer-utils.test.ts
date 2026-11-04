import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import {
  buildWindowsAgentHookPostCommand,
  buildWindowsAgentHookCurlPostCommand,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  hookDefinitionHasManagedCommand,
  removeManagedCommands,
  wrapPosixHookCommand,
  readHooksJsonWithRaw,
  wrapWindowsHookCommand,
  writeManagedScript,
  writeHooksJson,
  type HooksConfig
} from './installer-utils'
import { buildPosixAgentHookPostCommand } from './hook-post-command'
import { WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD } from './hook-stdin-contract'
import { wrapRuntimeHomeHookCommand } from './runtime-home-hook-command'
import { findBareHookCommandVariables } from './managed-hook-command-env.test-fixture'

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'orca-installer-utils-test-'))
  configPath = join(tmpDir, 'settings.json')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('readHooksJsonWithRaw', () => {
  it('returns the parsed config together with the exact bytes it came from', () => {
    const contents = '{"hooks": {"Stop": []}, "custom": 1}\n'
    writeFileSync(configPath, contents, 'utf-8')

    expect(readHooksJsonWithRaw(configPath)).toEqual({
      raw: contents,
      config: { hooks: { Stop: [] }, custom: 1 }
    })
  })

  it('parses one leading BOM while preserving the exact raw contents', () => {
    const contents = '\uFEFF{"hooks": {"Stop": []}, "custom": 1}\n'
    writeFileSync(configPath, contents, 'utf-8')

    expect(readHooksJsonWithRaw(configPath)).toEqual({
      raw: contents,
      config: { hooks: { Stop: [] }, custom: 1 }
    })
  })

  it('rejects multiple or misplaced BOM characters', () => {
    const body = '{"hooks": {"Stop": []}}'
    for (const contents of [`\uFEFF\uFEFF${body}`, ` \uFEFF${body}`, `{\uFEFF"hooks": {}}`]) {
      writeFileSync(configPath, contents, 'utf-8')

      expect(readHooksJsonWithRaw(configPath)).toEqual({
        raw: contents,
        config: null
      })
    }
  })

  it('reports a missing file as an empty config with no raw bytes', () => {
    expect(readHooksJsonWithRaw(configPath)).toEqual({ raw: null, config: {} })
  })

  it('keeps the raw bytes when the contents are malformed JSON', () => {
    writeFileSync(configPath, 'not json\n', 'utf-8')

    expect(readHooksJsonWithRaw(configPath)).toEqual({
      raw: 'not json\n',
      config: null
    })
  })
})

describe('writeHooksJson', () => {
  const stopHookConfig = (command: string): HooksConfig => ({
    hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] }
  })

  it('updates a symlink target without replacing the hook config link', () => {
    const targetPath = join(tmpDir, 'dotfiles-hooks.json')
    writeFileSync(targetPath, '{"hooks":{}}\n')
    symlinkSync(targetPath, configPath)

    writeHooksJson(configPath, { hooks: { Stop: [] } })

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(targetPath, 'utf-8'))).toEqual({
      hooks: { Stop: [] }
    })
  })

  it('does not replace a dangling hook config symlink', () => {
    const targetPath = join(tmpDir, 'missing-dotfiles-hooks.json')
    symlinkSync(targetPath, configPath)

    expect(() => writeHooksJson(configPath, { hooks: { Stop: [] } })).toThrow()

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(existsSync(targetPath)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'keeps an owner-only config owner-only when it rewrites it',
    () => {
      writeFileSync(configPath, '{"hooks":{}}\n')
      chmodSync(configPath, 0o600)

      writeHooksJson(configPath, { hooks: { Stop: [] } })

      expect(statSync(configPath).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({ hooks: { Stop: [] } })
    }
  )

  it('writes the config as formatted JSON', () => {
    const config = stopHookConfig('foo')
    writeHooksJson(configPath, config)
    expect(readFileSync(configPath, 'utf-8')).toBe(`{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "foo"
          }
        ]
      }
    ]
  }
}
`)
  })

  it('creates the directory if it does not exist', () => {
    const nested = join(tmpDir, 'sub', 'dir', 'settings.json')
    writeHooksJson(nested, {})
    expect(readFileSync(nested, 'utf-8')).toBe('{}\n')
  })

  it('creates a .bak file from the previous content before overwriting', () => {
    const original = stopHookConfig('original')
    writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`, 'utf-8')

    const updated = stopHookConfig('updated')
    writeHooksJson(configPath, updated)

    const bak = JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8'))
    expect(bak).toEqual(original)
  })

  it('does not follow an existing .bak symlink', () => {
    const original = '{"hooks":{}}\n'
    const backupTarget = join(tmpDir, 'dotfiles-backup.json')
    writeFileSync(configPath, original, 'utf-8')
    writeFileSync(backupTarget, 'pristine backup target\n', 'utf-8')
    symlinkSync(backupTarget, `${configPath}.bak`)

    expect(() => writeHooksJson(configPath, { hooks: { Stop: [] } })).toThrow(
      'Refusing to overwrite symlinked backup'
    )

    expect(readFileSync(configPath, 'utf-8')).toBe(original)
    expect(lstatSync(`${configPath}.bak`).isSymbolicLink()).toBe(true)
    expect(readFileSync(backupTarget, 'utf-8')).toBe('pristine backup target\n')
  })

  it('does not create a .bak file when the config does not yet exist', () => {
    writeHooksJson(configPath, {})
    expect(existsSync(`${configPath}.bak`)).toBe(false)
  })

  it('is a no-op (does not rotate .bak) when the serialized content is unchanged', () => {
    const config = stopHookConfig('foo')
    writeHooksJson(configPath, config)
    // First write had no prior file, so no .bak should exist.
    expect(existsSync(`${configPath}.bak`)).toBe(false)

    // Writing identical content must not create or rotate the .bak file.
    writeHooksJson(configPath, config)
    expect(existsSync(`${configPath}.bak`)).toBe(false)

    // A second distinct write must still produce a .bak from the prior content,
    // proving the no-op only triggers on byte-identical content.
    const updated = stopHookConfig('bar')
    writeHooksJson(configPath, updated)
    const bak = JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8'))
    expect(bak).toEqual(config)
  })

  it('updates the .bak file to the previous version on each write', () => {
    const v1 = stopHookConfig('v1')
    const v2 = stopHookConfig('v2')
    const v3 = stopHookConfig('v3')

    writeHooksJson(configPath, v1)
    writeHooksJson(configPath, v2)
    writeHooksJson(configPath, v3)

    // .bak should hold v2 (the version before v3)
    const bak = JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8'))
    expect(bak).toEqual(v2)
    const current = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(current).toEqual(v3)
  })

  it('cleans temporary output when writing to an existing directory fails', () => {
    const blockingDir = configPath
    mkdirSync(blockingDir)

    expect(() => writeHooksJson(blockingDir, { hooks: {} })).toThrow()

    const entries = readdirSync(tmpDir)
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0)
  })
})

describe('createManagedCommandMatcher', () => {
  const match = createManagedCommandMatcher('claude-hook.sh')

  it('matches commands containing the agent-hooks/<scriptFileName> path', () => {
    expect(
      match('/bin/sh "/Users/alice/Library/Application Support/Orca/agent-hooks/claude-hook.sh"')
    ).toBe(true)
    expect(match('/bin/sh "/some/other/location/agent-hooks/claude-hook.sh"')).toBe(true)
  })

  it('normalizes Windows backslashes so cmd-style paths still match', () => {
    expect(match('C:\\Users\\alice\\AppData\\Roaming\\Orca\\agent-hooks\\claude-hook.sh')).toBe(
      true
    )
  })

  it('returns false for unrelated commands', () => {
    expect(match(undefined)).toBe(false)
    expect(match('')).toBe(false)
    expect(match('echo "user-authored hook"')).toBe(false)
    // A matching filename outside agent-hooks remains user-owned.
    expect(match('/bin/sh "/home/alice/scripts/claude-hook.sh"')).toBe(false)
  })

  it('does not match hooks for a different agent', () => {
    expect(match('/bin/sh "/path/agent-hooks/gemini-hook.sh"')).toBe(false)
  })

  it('matches the guarded launcher form so wrapped commands sweep correctly', () => {
    expect(
      match(
        'if [ -x "/Users/alice/Library/Application Support/Orca/agent-hooks/claude-hook.sh" ]; then /bin/sh "/Users/alice/Library/Application Support/Orca/agent-hooks/claude-hook.sh"; fi'
      )
    ).toBe(true)
  })

  it('matches encoded Windows launcher commands by decoding their script path', () => {
    const command = wrapWindowsHookCommand('C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd')
    expect(match(command)).toBe(true)
  })

  it('matches the pre-default-form launcher so upgrades replace it instead of duplicating', () => {
    expect(
      match(
        'if [ -z "$HOME" ]; then :; else if [ -f "$HOME/.orca/agent-hooks/claude-hook.sh" ]; then /bin/sh "$HOME/.orca/agent-hooks/claude-hook.sh"; fi; fi'
      )
    ).toBe(true)
  })

  it('matches PowerShell and POSIX variants across Copilot platform switches', () => {
    const matchPosix = createManagedCommandMatcher('copilot-hook.sh')
    const matchPowerShell = createManagedCommandMatcher('copilot-hook.ps1')

    expect(matchPosix("& 'C:\\Users\\alice\\.orca\\agent-hooks\\copilot-hook.ps1'")).toBe(true)
    expect(
      matchPosix(wrapWindowsHookCommand('C:\\Users\\alice\\.orca\\agent-hooks\\copilot-hook.ps1'))
    ).toBe(true)
    expect(matchPowerShell("/bin/sh '/home/alice/.orca/agent-hooks/copilot-hook.sh'")).toBe(true)
  })
})

describe('removeManagedCommands', () => {
  const match = createManagedCommandMatcher('copilot-hook.sh')

  it('removes managed direct bash/powershell/command fields', () => {
    const cleaned = removeManagedCommands(
      [
        {
          type: 'command',
          bash: '/bin/sh "/Users/alice/Orca/agent-hooks/copilot-hook.sh"',
          timeoutSec: 5
        },
        {
          type: 'command',
          powershell: "& 'C:\\Users\\alice\\Orca\\agent-hooks\\copilot-hook.sh'",
          timeoutSec: 5
        },
        {
          type: 'command',
          command: 'echo user hook',
          timeoutSec: 5
        }
      ],
      match
    )

    expect(cleaned).toEqual([{ type: 'command', command: 'echo user hook', timeoutSec: 5 }])
  })

  it('preserves unrelated nested hooks while removing managed entries', () => {
    const cleaned = removeManagedCommands(
      [
        {
          hooks: [
            {
              type: 'command',
              command: '/bin/sh "/path/agent-hooks/copilot-hook.sh"'
            },
            { type: 'command', command: 'echo keep me' }
          ]
        }
      ],
      match
    )

    expect(cleaned).toEqual([{ hooks: [{ type: 'command', command: 'echo keep me' }] }])
  })

  it('removes exec-form hooks whose managed script path is an argument', () => {
    const cleaned = removeManagedCommands(
      [
        {
          hooks: [
            {
              type: 'command',
              command: 'C:\\Windows\\System32\\conhost.exe',
              args: [
                '--headless',
                'C:\\Windows\\System32\\cmd.exe',
                '/d',
                '/c',
                'C:\\Users\\alice\\.orca\\agent-hooks\\copilot-hook.cmd'
              ]
            },
            { type: 'command', command: 'echo keep me' }
          ]
        }
      ],
      match
    )

    expect(cleaned).toEqual([{ hooks: [{ type: 'command', command: 'echo keep me' }] }])
  })

  it('preserves user hooks with malformed args fields', () => {
    const definitions = [
      {
        hooks: [
          {
            type: 'command' as const,
            command: 'echo keep me',
            args: 'not-an-array' as unknown as string[]
          },
          {
            type: 'command' as const,
            command: 'echo keep me too',
            args: [42] as unknown as string[]
          }
        ]
      }
    ]

    expect(removeManagedCommands(definitions, match)).toEqual(definitions)
  })
})

describe('hookDefinitionHasManagedCommand', () => {
  it('detects managed commands in direct and nested fields', () => {
    const match = createManagedCommandMatcher('copilot-hook.sh')

    expect(
      hookDefinitionHasManagedCommand(
        { bash: '/bin/sh "/Users/alice/Orca/agent-hooks/copilot-hook.sh"' },
        match
      )
    ).toBe(true)
    expect(
      hookDefinitionHasManagedCommand(
        {
          hooks: [
            {
              type: 'command',
              command: '/bin/sh "/path/agent-hooks/copilot-hook.sh"'
            }
          ]
        },
        match
      )
    ).toBe(true)
    expect(
      hookDefinitionHasManagedCommand(
        {
          hooks: [
            {
              type: 'command',
              command: 'C:\\Windows\\System32\\conhost.exe',
              args: ['--headless', 'C:\\Users\\alice\\.orca\\agent-hooks\\copilot-hook.cmd']
            }
          ]
        },
        match
      )
    ).toBe(true)
    expect(
      hookDefinitionHasManagedCommand(
        {
          hooks: [
            {
              type: 'command',
              command: 'echo no',
              args: 'not-an-array' as unknown as string[]
            }
          ]
        },
        match
      )
    ).toBe(false)
    expect(hookDefinitionHasManagedCommand({ bash: 'echo no' }, match)).toBe(false)
  })
})

describe('getSharedManagedScriptPath', () => {
  it("returns ~/.orca/agent-hooks/<scriptFileName> rooted at the user's home", () => {
    expect(getSharedManagedScriptPath('claude-hook.sh')).toBe(
      join(homedir(), '.orca', 'agent-hooks', 'claude-hook.sh')
    )
  })
})

describe('writeManagedScript', () => {
  it.skipIf(process.platform === 'win32')(
    'repairs executable bits even when script content is unchanged',
    () => {
      const scriptPath = join(tmpDir, 'agent-hooks', 'claude-hook.sh')

      writeManagedScript(scriptPath, '#!/bin/sh\nexit 0\n')
      chmodSync(scriptPath, 0o644)

      writeManagedScript(scriptPath, '#!/bin/sh\nexit 0\n')

      expect(statSync(scriptPath).mode & 0o111).not.toBe(0)
    }
  )
})

describe('wrapPosixHookCommand', () => {
  it.skipIf(process.platform === 'win32')(
    'executes a script whose path contains a single quote literally',
    () => {
      const scriptPath = join(tmpDir, "with'quote", 'hook.sh')
      mkdirSync(join(tmpDir, "with'quote"))
      writeFileSync(scriptPath, "#!/bin/sh\nprintf 'quoted-path\n'\n", { mode: 0o755 })
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', wrapPosixHookCommand(scriptPath)],
        timeoutMs: 5000
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('quoted-path\n')
      expect(result.stderr).toBe('')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'passes a literal environment value only to the guarded script',
    () => {
      const scriptPath = join(tmpDir, 'env-hook.sh')
      const event = "UserPromptSubmit ' $HOME ;"
      writeFileSync(scriptPath, '#!/bin/sh\nprintf "%s" "$ORCA_COPILOT_HOOK_EVENT"\n', {
        mode: 0o755
      })
      const command = wrapPosixHookCommand(scriptPath, { ORCA_COPILOT_HOOK_EVENT: event })
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', `${command}; printf '\n%s' "$ORCA_COPILOT_HOOK_EVENT"`],
        env: { ...process.env, ORCA_COPILOT_HOOK_EVENT: 'parent-value' },
        timeoutMs: 5000
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${event}\nparent-value`)
      expect(result.stderr).toBe('')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'returns exit code 0 when the script does not exist (no-op)',
    () => {
      const cmd = wrapPosixHookCommand('/does/not/exist.sh')
      const result = runProcessSync({ program: '/bin/sh', args: ['-c', cmd], timeoutMs: 5000 })
      expect(result.code).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'writes the fallback response and still drains a large stdin payload',
    () => {
      const cmd = wrapPosixHookCommand('/does/not/exist.sh', {}, { fallbackStdout: '{"a":"b"}' })
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', cmd],
        input: 'x'.repeat(1_000_000),
        timeoutMs: 5000
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('{"a":"b"}\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'runs the script instead of the fallback when the script is present',
    () => {
      const scriptPath = join(tmpDir, 'present-hook.sh')
      writeFileSync(scriptPath, "#!/bin/sh\nprintf 'from-script\\n'\n", { mode: 0o755 })
      const cmd = wrapPosixHookCommand(scriptPath, {}, { fallbackStdout: '{"a":"b"}' })
      const result = runProcessSync({ program: '/bin/sh', args: ['-c', cmd], timeoutMs: 5000 })
      expect(result.stdout).toBe('from-script\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'drains stdin when a directory occupies the managed script path',
    () => {
      const scriptPath = join(tmpDir, 'directory-hook.sh')
      mkdirSync(scriptPath)
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', wrapPosixHookCommand(scriptPath)],
        input: 'x'.repeat(1_000_000),
        timeoutMs: 5000
      })

      expect(result.timedOut).toBe(false)
      expect(result.code).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'drains stdin when the managed script is executable but unreadable',
    () => {
      const scriptPath = join(tmpDir, 'unreadable-hook.sh')
      writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', 'utf-8')
      chmodSync(scriptPath, 0o111)
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', wrapPosixHookCommand(scriptPath)],
        input: 'x'.repeat(1_000_000),
        timeoutMs: 5000
      })

      expect(result.timedOut).toBe(false)
      expect(result.code).toBe(0)
    }
  )

  // 4d618795 replaced && … || true to preserve failing script exit codes; guard against swallowing them again.
  it.skipIf(process.platform === 'win32')(
    'propagates the script exit code when the script runs and fails',
    () => {
      const scriptPath = join(tmpDir, 'fails.sh')
      writeFileSync(scriptPath, '#!/bin/sh\nexit 7\n', 'utf-8')
      chmodSync(scriptPath, 0o755)
      const cmd = wrapPosixHookCommand(scriptPath)
      const result = runProcessSync({ program: '/bin/sh', args: ['-c', cmd], timeoutMs: 5000 })
      expect(result.code).toBe(7)
    }
  )
})

const qualifiedWindowsPowerShellCommand =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -EncodedCommand \S+$/

function decodeWindowsHookCommand(command: string): string {
  const encodedCommand = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  expect(encodedCommand).toBeTruthy()
  return Buffer.from(encodedCommand!, 'base64').toString('utf16le')
}

describe('wrapWindowsHookCommand', () => {
  it('invokes the .cmd through an encoded PowerShell command', () => {
    const command = wrapWindowsHookCommand('C:\\Users\\alice\\.orca\\agent-hooks\\codex-hook.cmd')
    expect(command).toMatch(qualifiedWindowsPowerShellCommand)
    expect(command).not.toMatch(/^powershell\b/i)
    const decoded = decodeWindowsHookCommand(command)
    expect(decoded).toMatch(/^\$ProgressPreference='SilentlyContinue'; try \{ Set-ExecutionPolicy/)
    expect(decoded).toContain(
      "Test-Path -LiteralPath 'C:\\Users\\alice\\.orca\\agent-hooks\\codex-hook.cmd' -PathType Leaf"
    )
    expect(decoded).toContain(
      "& 'C:\\Users\\alice\\.orca\\agent-hooks\\codex-hook.cmd'; exit $LASTEXITCODE"
    )
    expect(decoded).toContain('[Console]::In.ReadToEnd() | Out-Null; exit 0')
  })

  it('doubles typographic single quotes in the script path literal', () => {
    const decoded = decodeWindowsHookCommand(
      wrapWindowsHookCommand('C:\\Users\\O\u2019Brien\\.orca\\agent-hooks\\codex-hook.cmd')
    )
    expect(decoded).toContain(
      "Test-Path -LiteralPath 'C:\\Users\\O\u2019\u2019Brien\\.orca\\agent-hooks\\codex-hook.cmd'"
    )
  })

  it('scopes environment variables inside the encoded launcher', () => {
    const command = wrapWindowsHookCommand('C:\\hooks\\copilot-hook.ps1', {
      ORCA_COPILOT_HOOK_EVENT: 'UserPromptSubmit'
    })
    expect(decodeWindowsHookCommand(command)).toContain(
      "$env:ORCA_COPILOT_HOOK_EVENT = 'UserPromptSubmit'; if (Test-Path"
    )
  })

  // Gate events read silence as denial, so answer before a missing-context guard can exit.
  it('answers before it guards, and guards before it owns stdin', () => {
    const decoded = decodeWindowsHookCommand(
      wrapWindowsHookCommand(
        'C:\\hooks\\cursor-hook.cmd',
        {},
        { fallbackStdout: '{"permission":"allow"}' }
      )
    )
    const answer = decoded.indexOf('Write-Output \'{"permission":"allow"}\'')
    const guard = decoded.indexOf(WINDOWS_POWERSHELL_HOOK_ENVIRONMENT_GUARD)
    const ownsStdin = decoded.indexOf('[Console]::In.ReadToEnd()')
    expect(answer).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(answer)
    expect(ownsStdin).toBeGreaterThan(guard)
  })

  it('keeps cmd.exe percent expansion and caret escapes out of the command line', () => {
    const cmd = wrapWindowsHookCommand('C:\\Users\\%ORCA_TEST%\\a^b\\codex-hook.cmd')
    expect(cmd).not.toContain('%ORCA_TEST%')
    expect(cmd).not.toContain('^')
    expect(decodeWindowsHookCommand(cmd)).toContain(
      "Test-Path -LiteralPath 'C:\\Users\\%ORCA_TEST%\\a^b\\codex-hook.cmd' -PathType Leaf"
    )
  })

  it.skipIf(process.platform !== 'win32')(
    'executes a script path containing a cmd.exe caret literally',
    () => {
      const scriptDir = join(tmpDir, 'home with ^ caret', '.orca', 'agent-hooks')
      mkdirSync(scriptDir, { recursive: true })
      const scriptPath = join(scriptDir, 'codex-hook.cmd')
      writeFileSync(scriptPath, '@echo off\r\nexit /b 7\r\n', 'utf-8')

      const result = runProcessSync({
        program: 'cmd.exe',
        args: ['/d', '/c', wrapWindowsHookCommand(scriptPath)],
        env: { ...process.env, ORCA_WRAP_TEST: 'expanded' },
        timeoutMs: 5000
      })

      expect(result.code).toBe(7)
    }
  )
})

describe('wrapRuntimeHomeHookCommand', () => {
  const shell =
    process.platform === 'win32'
      ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
      : '/bin/sh'

  it('selects the runtime platform variant under HOME', () => {
    const command = wrapRuntimeHomeHookCommand('claude-hook')

    expect(command).toContain('case "${OSTYPE-}" in msys*|cygwin*|win32*)')
    expect(command).toContain('case "${HOME-}" in *\\&*|*\\^*|*\\(*|*\\)*|*\\;*|*,*|*=*|*%*|*\\!*)')
    expect(command).not.toContain('uname')
    expect(command).toContain('"${HOME-}/.orca/agent-hooks/claude-hook.cmd"')
    expect(command).toContain('/bin/sh "${HOME-}/.orca/agent-hooks/claude-hook.sh"')
    expect(command).not.toMatch(/[A-Z]:[\\/]|\/Users\/|\/home\//)
  })

  // Grok rejects unresolved bare variables even in untaken branches.
  it.each([
    ['default', undefined],
    ['neutral-json', { neutralJsonWhenMissing: true }]
  ])(
    'references every variable in default form (%s) so a static precheck cannot reject it',
    (_label, options) => {
      const command = wrapRuntimeHomeHookCommand('claude-hook', options)

      expect(command).toContain('"${SYSTEMROOT-}/System32/WindowsPowerShell/v1.0/powershell.exe"')
      expect(findBareHookCommandVariables(command)).toEqual([])
    }
  )

  it('uses the permitted PowerShell flag shape on the Git Bash branch', () => {
    // Git Bash has no console to inherit (#14815); preserve the exact AV-reviewed PowerShell flag shape (#16003).
    const command = wrapRuntimeHomeHookCommand('claude-hook')

    expect(command).toContain('powershell.exe" -NoProfile -EncodedCommand ')
    expect(command).not.toMatch(/-ExecutionPolicy/i)
  })

  it('rejects a script base name that could inject shell syntax', () => {
    expect(() => wrapRuntimeHomeHookCommand('claude-hook; echo injected')).toThrow(
      'Invalid managed script base name'
    )
  })

  it('executes the destination HOME script for the current runtime', () => {
    const sourceHome = join(tmpDir, 'source profile')
    const destinationHome = join(tmpDir, "destination $HOME ' & profile")
    const sourceScriptDir = join(sourceHome, '.orca', 'agent-hooks')
    const destinationScriptDir = join(destinationHome, '.orca', 'agent-hooks')
    mkdirSync(sourceScriptDir, { recursive: true })
    mkdirSync(destinationScriptDir, { recursive: true })
    const windowsExitCode = process.platform === 'win32' ? 7 : 9
    const posixExitCode = process.platform === 'win32' ? 9 : 7
    writeFileSync(
      join(destinationScriptDir, 'claude-hook.cmd'),
      `@echo off\r\nexit /b ${windowsExitCode}\r\n`,
      'utf-8'
    )
    writeFileSync(
      join(destinationScriptDir, 'claude-hook.sh'),
      `#!/bin/sh\nexit ${posixExitCode}\n`,
      'utf-8'
    )
    writeFileSync(join(sourceScriptDir, 'claude-hook.cmd'), '@echo off\r\nexit /b 9\r\n', 'utf-8')
    writeFileSync(join(sourceScriptDir, 'claude-hook.sh'), '#!/bin/sh\nexit 9\n', 'utf-8')
    chmodSync(join(destinationScriptDir, 'claude-hook.sh'), 0o755)

    const result = runProcessSync({
      program: shell,
      args: ['-c', wrapRuntimeHomeHookCommand('claude-hook')],
      env: {
        ...process.env,
        HOME: destinationHome.replaceAll('\\', '/'),
        USERPROFILE: destinationHome
      },
      timeoutMs: 5000
    })

    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr.toString()).toBe(7)
  })

  it.skipIf(process.platform !== 'win32')('keeps common Windows profiles on the fast path', () => {
    const destinationHome = join(tmpDir, 'destination 国際 profile')
    const scriptDir = join(destinationHome, '.orca', 'agent-hooks')
    mkdirSync(scriptDir, { recursive: true })
    writeFileSync(join(scriptDir, 'claude-hook.cmd'), '@echo off\r\nexit /b 7\r\n', 'utf-8')
    const result = runProcessSync({
      program: shell,
      args: ['-c', wrapRuntimeHomeHookCommand('claude-hook')],
      env: { ...process.env, HOME: destinationHome.replaceAll('\\', '/') },
      timeoutMs: 5000
    })

    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr.toString()).toBe(7)
  })

  it('drains stdin when HOME is unavailable', () => {
    const command = `unset HOME; ${wrapRuntimeHomeHookCommand('claude-hook')}`
    const result = runProcessSync({
      program: shell,
      args: ['-c', command],
      input: 'x'.repeat(1_000_000),
      timeoutMs: 5000
    })

    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
  })

  it('emits neutral JSON when a lifecycle script is missing', () => {
    const result = runProcessSync({
      program: shell,
      args: [
        '-c',
        wrapRuntimeHomeHookCommand('missing-orca-hook', { neutralJsonWhenMissing: true })
      ],
      env: { ...process.env, HOME: tmpDir.replaceAll('\\', '/') },
      input: 'x'.repeat(1_000_000),
      timeoutMs: 5000
    })

    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr.toString()).toBe(0)
    expect(JSON.parse(result.stdout.toString().trim())).toEqual({})
  })
})

describe('buildWindowsAgentHookPostCommand', () => {
  it('posts hook stdin through bounded curl without spawning PowerShell', () => {
    const command = buildWindowsAgentHookPostCommand('codex')

    expect(command).toContain('"%SystemRoot%\\System32\\curl.exe" -sS -X POST')
    expect(command).toContain('--connect-timeout 0.5 --max-time 1.5')
    expect(command).toContain('-H "Content-Type: application/x-www-form-urlencoded"')
    expect(command).toContain('-H "X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%"')
    expect(command).toContain('--data-urlencode "paneKey=%ORCA_PANE_KEY%"')
    expect(command).toContain('--data-urlencode "payload@-"')
    expect(command).toContain('/hook/codex')
    expect(command).not.toContain('powershell')
    expect(command).not.toContain('Invoke-WebRequest')
  })

  it('does not resolve curl from the current directory or PATH', () => {
    const command = buildWindowsAgentHookPostCommand('gemini')

    expect(command).toMatch(/^"%SystemRoot%\\System32\\curl\.exe"/)
    expect(command).not.toMatch(/^curl\.exe\b/)
  })
})

describe('buildPosixAgentHookPostCommand', () => {
  it.skipIf(process.platform === 'win32').each([
    ['raw-json-v1', 'application/json', '--data-binary', '@-'],
    ['', 'application/x-www-form-urlencoded', '--data-urlencode', 'payload@-'],
    ['future-transport', 'application/x-www-form-urlencoded', '--data-urlencode', 'payload@-']
  ])(
    'uses the compatible transport for advertisement %s',
    (transport, contentType, flag, value) => {
      const argsPath = join(tmpDir, 'curl-args.jsonl')
      const payloadPath = join(tmpDir, 'curl-payload')
      const payload = '{"prompt":"漢字 $HOME & quoted"}'
      const command = [
        'curl() { printf "%s\n" "$@" > "$ORCA_TEST_CURL_ARGS"; cat > "$ORCA_TEST_CURL_PAYLOAD"; }',
        'payload="$ORCA_TEST_PAYLOAD"',
        ...buildPosixAgentHookPostCommand('claude')
      ].join('\n')
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', command],
        env: {
          PATH: '/usr/bin:/bin',
          ORCA_AGENT_HOOK_TRANSPORT: transport,
          ORCA_AGENT_HOOK_PORT: '1234',
          ORCA_AGENT_HOOK_TOKEN: 'token',
          ORCA_PANE_KEY: 'tab:leaf',
          ORCA_TAB_ID: 'tab',
          ORCA_AGENT_LAUNCH_TOKEN: 'launch',
          ORCA_WORKTREE_ID: 'folder:/path & space',
          ORCA_AGENT_HOOK_ENV: 'prod',
          ORCA_AGENT_HOOK_VERSION: '1',
          ORCA_TEST_CURL_ARGS: argsPath,
          ORCA_TEST_CURL_PAYLOAD: payloadPath,
          ORCA_TEST_PAYLOAD: payload
        },
        timeoutMs: 5000
      })
      expect(result.code).toBe(0)
      const args = readFileSync(argsPath, 'utf8').trimEnd().split('\n')
      expect(args).toContain(`Content-Type: ${contentType}`)
      expect(args).toContain('http://127.0.0.1:1234/hook/claude')
      expect(args).toContain('X-Orca-Agent-Hook-Token: token')
      const payloadFlagIndex = args.lastIndexOf(flag)
      expect(args.slice(payloadFlagIndex, payloadFlagIndex + 2)).toEqual([flag, value])
      expect(readFileSync(payloadPath, 'utf8')).toBe(payload)
      if (transport === 'raw-json-v1') {
        expect(args).not.toContain('--data-urlencode')
        const metadata = args.find((arg) => arg.startsWith('X-Orca-Agent-Hook-Meta: '))
        expect(metadata).toBeDefined()
        expect(
          Buffer.from(metadata!.slice('X-Orca-Agent-Hook-Meta: '.length), 'base64').toString()
        ).toBe('tab:leaf\x1ftab\x1flaunch\x1ffolder:/path & space\x1fprod\x1f1')
      } else {
        expect(args).not.toContain('--data-binary')
        expect(args).toContain('paneKey=tab:leaf')
        expect(args).toContain('worktreeId=folder:/path & space')
      }
    }
  )
})

describe('buildWindowsAgentHookCurlPostCommand', () => {
  it('posts form fields via curl.exe and reads the payload from stdin', () => {
    const command = buildWindowsAgentHookCurlPostCommand('codex')

    expect(command).not.toMatch(/powershell/i)
    expect(command).toContain('%SystemRoot%\\System32\\curl.exe')
    expect(command).toContain('http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/codex')
    expect(command).toContain('-H "Content-Type: application/x-www-form-urlencoded"')
    expect(command).toContain('-H "X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%"')
    expect(command).toContain('--data-urlencode "paneKey=%ORCA_PANE_KEY%"')
    expect(command).toContain('--data-urlencode "worktreeId=%ORCA_WORKTREE_ID%"')
    // payload@- preserves stdin’s UTF-8 bytes without code-page conversion.
    expect(command).toContain('--data-urlencode "payload@-"')
    expect(command).toContain('--connect-timeout 0.5 --max-time 1.5')
  })
})
