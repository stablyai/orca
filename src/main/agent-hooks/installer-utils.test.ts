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
import { spawnSync } from 'node:child_process'
import {
  buildWindowsAgentHookPostCommand,
  buildWindowsAgentHookCurlPostCommand,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  hookDefinitionHasManagedCommand,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand,
  wrapWindowsGitBashHookCommand,
  readHooksJsonWithRaw,
  wrapWindowsHookCommand,
  writeManagedScript,
  writeHooksJson,
  type HooksConfig
} from './installer-utils'

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

  it('reports a missing file as an empty config with no raw bytes', () => {
    expect(readHooksJsonWithRaw(configPath)).toEqual({ raw: null, config: {} })
  })

  it('keeps the raw bytes when the contents are not a JSON object', () => {
    writeFileSync(configPath, 'not json\n', 'utf-8')

    expect(readHooksJsonWithRaw(configPath)).toEqual({ raw: 'not json\n', config: null })
  })
})

describe('writeHooksJson', () => {
  it('updates a symlink target without replacing the hook config link', () => {
    const targetPath = join(tmpDir, 'dotfiles-hooks.json')
    writeFileSync(targetPath, '{"hooks":{}}\n')
    symlinkSync(targetPath, configPath)

    writeHooksJson(configPath, { hooks: { Stop: [] } })

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(targetPath, 'utf-8'))).toEqual({ hooks: { Stop: [] } })
  })

  it('does not replace a dangling hook config symlink', () => {
    const targetPath = join(tmpDir, 'missing-dotfiles-hooks.json')
    symlinkSync(targetPath, configPath)

    expect(() => writeHooksJson(configPath, { hooks: { Stop: [] } })).toThrow()

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(existsSync(targetPath)).toBe(false)
  })

  it('writes the config as formatted JSON', () => {
    const config: HooksConfig = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foo' }] }] }
    }
    writeHooksJson(configPath, config)
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written).toEqual(config)
  })

  it('creates the directory if it does not exist', () => {
    const nested = join(tmpDir, 'sub', 'dir', 'settings.json')
    writeHooksJson(nested, {})
    expect(existsSync(nested)).toBe(true)
  })

  it('creates a .bak file from the previous content before overwriting', () => {
    const original: HooksConfig = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'original' }] }] }
    }
    writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`, 'utf-8')

    const updated: HooksConfig = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'updated' }] }] }
    }
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
    const config: HooksConfig = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'foo' }] }] }
    }
    writeHooksJson(configPath, config)
    // First write had no prior file, so no .bak should exist.
    expect(existsSync(`${configPath}.bak`)).toBe(false)

    // Writing identical content must not create or rotate the .bak file.
    writeHooksJson(configPath, config)
    expect(existsSync(`${configPath}.bak`)).toBe(false)

    // A second distinct write must still produce a .bak from the prior content,
    // proving the no-op only triggers on byte-identical content.
    const updated: HooksConfig = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bar' }] }] }
    }
    writeHooksJson(configPath, updated)
    const bak = JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8'))
    expect(bak).toEqual(config)
  })

  it('updates the .bak file to the previous version on each write', () => {
    const v1: HooksConfig = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'v1' }] }] } }
    const v2: HooksConfig = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'v2' }] }] } }
    const v3: HooksConfig = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'v3' }] }] } }

    writeHooksJson(configPath, v1)
    writeHooksJson(configPath, v2)
    writeHooksJson(configPath, v3)

    // .bak should hold v2 (the version before v3)
    const bak = JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8'))
    expect(bak).toEqual(v2)
    // configPath should hold v3
    const current = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(current).toEqual(v3)
  })

  it('leaves no temp file behind if the rename fails', () => {
    // Why: verifies the atomic cleanup — if the rename cannot complete (here,
    // because the target is a directory that cannot be overwritten), the finally
    // block must remove the temp file so ~/.claude is not littered with orphans.
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
    // Same filename but not under an agent-hooks/ directory — treat as
    // user-authored to avoid stomping on someone else's hook.
    expect(match('/bin/sh "/home/alice/scripts/claude-hook.sh"')).toBe(false)
  })

  it('does not match hooks for a different agent', () => {
    expect(match('/bin/sh "/path/agent-hooks/gemini-hook.sh"')).toBe(false)
  })

  it('matches the guarded launcher form so wrapped commands sweep correctly', () => {
    // Why: older guarded launchers used a single `-x` check. The sweep must
    // still recognize them or reinstalling would retain a stale duplicate.
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

  it('matches PowerShell and POSIX variants across Copilot platform switches', () => {
    const matchPosix = createManagedCommandMatcher('copilot-hook.sh')
    const matchPowerShell = createManagedCommandMatcher('copilot-hook.ps1')

    expect(matchPosix("& 'C:\\Users\\alice\\.orca\\agent-hooks\\copilot-hook.ps1'")).toBe(true)
    expect(
      matchPosix(wrapWindowsHookCommand('C:\\Users\\alice\\.orca\\agent-hooks\\copilot-hook.ps1'))
    ).toBe(true)
    expect(matchPowerShell("/bin/sh '/home/alice/.orca/agent-hooks/copilot-hook.sh'")).toBe(true)
  })

  it('matches the legacy per-userData script path AND the new shared ~/.orca path', () => {
    // Why: install() must sweep old per-userData commands when migrating to
    // the shared ~/.orca script path, or stale launchers keep failing.
    expect(
      match("/bin/sh '/Users/alice/Library/Application Support/orca/agent-hooks/claude-hook.sh'")
    ).toBe(true)
    expect(match("/bin/sh '/Users/alice/.orca/agent-hooks/claude-hook.sh'")).toBe(true)
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
            { type: 'command', command: '/bin/sh "/path/agent-hooks/copilot-hook.sh"' },
            { type: 'command', command: 'echo keep me' }
          ]
        }
      ],
      match
    )

    expect(cleaned).toEqual([{ hooks: [{ type: 'command', command: 'echo keep me' }] }])
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
        { hooks: [{ type: 'command', command: '/bin/sh "/path/agent-hooks/copilot-hook.sh"' }] },
        match
      )
    ).toBe(true)
    expect(hookDefinitionHasManagedCommand({ bash: 'echo no' }, match)).toBe(false)
  })
})

describe('getSharedManagedScriptPath', () => {
  it("returns ~/.orca/agent-hooks/<scriptFileName> rooted at the user's home", () => {
    expect(getSharedManagedScriptPath('claude-hook.sh')).toBe(
      join(homedir(), '.orca', 'agent-hooks', 'claude-hook.sh')
    )
  })

  it('does not depend on Electron app.getPath, so two Orca instances resolve to the same path', () => {
    // Why: using userData here would reintroduce dev/prod settings thrash.
    const a = getSharedManagedScriptPath('claude-hook.sh')
    const b = getSharedManagedScriptPath('claude-hook.sh')
    expect(a).toBe(b)
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
  it('produces a guarded command that no-ops when the script is missing', () => {
    const cmd = wrapPosixHookCommand('/does/not/exist.sh')
    expect(cmd).toBe(
      "if [ -f '/does/not/exist.sh' ] && [ -r '/does/not/exist.sh' ] && [ -x '/does/not/exist.sh' ]; then /bin/sh '/does/not/exist.sh'; else cat >/dev/null 2>&1 || :; fi"
    )
  })

  it('preserves spaces in the script path (Library/Application Support case)', () => {
    // Why: Electron's userData on macOS lives under "Application Support" with
    // a space. The guard must keep the path quoted so each file test and
    // `/bin/sh` see one argument.
    const cmd = wrapPosixHookCommand('/Users/a/Library/Application Support/Orca/agent-hooks/x.sh')
    expect(cmd).toContain("'/Users/a/Library/Application Support/Orca/agent-hooks/x.sh'")
  })

  it('escapes embedded single quotes so the wrapped command stays well-formed', () => {
    // Why: POSIX single-quote escape renders ' as '\''. Verify a path with an
    // embedded quote does not break out of the quoting and instead reaches
    // /bin/sh as a single argument.
    const cmd = wrapPosixHookCommand("/path/with'quote/x.sh")
    expect(cmd).toBe(
      "if [ -f '/path/with'\\''quote/x.sh' ] && [ -r '/path/with'\\''quote/x.sh' ] && [ -x '/path/with'\\''quote/x.sh' ]; then /bin/sh '/path/with'\\''quote/x.sh'; else cat >/dev/null 2>&1 || :; fi"
    )
  })

  it('can scope environment variables to the guarded script invocation', () => {
    const cmd = wrapPosixHookCommand('/does/not/exist.sh', {
      ORCA_COPILOT_HOOK_EVENT: 'UserPromptSubmit'
    })
    expect(cmd).toBe(
      "if [ -f '/does/not/exist.sh' ] && [ -r '/does/not/exist.sh' ] && [ -x '/does/not/exist.sh' ]; then ORCA_COPILOT_HOOK_EVENT='UserPromptSubmit' /bin/sh '/does/not/exist.sh'; else cat >/dev/null 2>&1 || :; fi"
    )
  })

  it.skipIf(process.platform === 'win32')(
    'returns exit code 0 when the script does not exist (no-op)',
    () => {
      const cmd = wrapPosixHookCommand('/does/not/exist.sh')
      const result = spawnSync('/bin/sh', ['-c', cmd])
      expect(result.status).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'drains stdin when a directory occupies the managed script path',
    () => {
      const scriptPath = join(tmpDir, 'directory-hook.sh')
      mkdirSync(scriptPath)
      const result = spawnSync('/bin/sh', ['-c', wrapPosixHookCommand(scriptPath)], {
        input: Buffer.alloc(1_000_000, 'x')
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
    }
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'drains stdin when the managed script is executable but unreadable',
    () => {
      const scriptPath = join(tmpDir, 'unreadable-hook.sh')
      writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', 'utf-8')
      chmodSync(scriptPath, 0o111)
      const result = spawnSync('/bin/sh', ['-c', wrapPosixHookCommand(scriptPath)], {
        input: Buffer.alloc(1_000_000, 'x')
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
    }
  )

  // Why: commit 4d618795 explicitly switched from `&& ... || true` (which
  // swallowed non-zero exits) to `if ... then ... fi` (which preserves the
  // script's exit code). This test guards against a future regression that
  // re-introduces the swallowing form.
  it.skipIf(process.platform === 'win32')(
    'propagates the script exit code when the script runs and fails',
    () => {
      const scriptPath = join(tmpDir, 'fails.sh')
      writeFileSync(scriptPath, '#!/bin/sh\nexit 7\n', 'utf-8')
      chmodSync(scriptPath, 0o755)
      const cmd = wrapPosixHookCommand(scriptPath)
      const result = spawnSync('/bin/sh', ['-c', cmd])
      expect(result.status).toBe(7)
    }
  )
})

const qualifiedWindowsPowerShellCommand =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand \S+$/

function decodeWindowsHookCommand(command: string): string {
  const encodedCommand = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  expect(encodedCommand).toBeTruthy()
  return Buffer.from(encodedCommand!, 'base64').toString('utf16le')
}

function expectedDecodedWindowsHookCommand(scriptPath: string): string {
  const quoted = `'${scriptPath.replaceAll("'", "''")}'`
  return `if (Test-Path -LiteralPath ${quoted} -PathType Leaf) { & ${quoted}; exit $LASTEXITCODE }; [Console]::In.ReadToEnd() | Out-Null; exit 0`
}

describe('wrapWindowsHookCommand', () => {
  it('invokes the .cmd through an encoded PowerShell command', () => {
    const command = wrapWindowsHookCommand('C:\\Users\\alice\\.orca\\agent-hooks\\codex-hook.cmd')
    expect(command).toMatch(qualifiedWindowsPowerShellCommand)
    expect(command).not.toMatch(/^powershell\b/i)
    expect(decodeWindowsHookCommand(command)).toBe(
      expectedDecodedWindowsHookCommand('C:\\Users\\alice\\.orca\\agent-hooks\\codex-hook.cmd')
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

  // Why: a user profile path like `C:\Users\Jane Doe` is the regression from
  // #6078 — the raw path used to be split at the space. The wrapper must keep
  // the whole path inside the encoded command so shells do not split it.
  it('preserves spaces in the script path (user profile with space case)', () => {
    const cmd = wrapWindowsHookCommand('C:\\Users\\Jorge Silva\\.orca\\agent-hooks\\codex-hook.cmd')
    expect(cmd).toMatch(qualifiedWindowsPowerShellCommand)
    expect(decodeWindowsHookCommand(cmd)).toBe(
      expectedDecodedWindowsHookCommand(
        'C:\\Users\\Jorge Silva\\.orca\\agent-hooks\\codex-hook.cmd'
      )
    )
  })

  it('keeps cmd.exe percent expansion and caret escapes out of the command line', () => {
    const cmd = wrapWindowsHookCommand('C:\\Users\\%ORCA_TEST%\\a^b\\codex-hook.cmd')
    expect(cmd).not.toContain('%ORCA_TEST%')
    expect(cmd).not.toContain('^')
    expect(decodeWindowsHookCommand(cmd)).toBe(
      expectedDecodedWindowsHookCommand('C:\\Users\\%ORCA_TEST%\\a^b\\codex-hook.cmd')
    )
  })

  it.skipIf(process.platform !== 'win32')(
    'executes a script path containing a cmd.exe caret literally',
    () => {
      const scriptDir = join(tmpDir, 'home with ^ caret', '.orca', 'agent-hooks')
      mkdirSync(scriptDir, { recursive: true })
      const scriptPath = join(scriptDir, 'codex-hook.cmd')
      writeFileSync(scriptPath, '@echo off\r\nexit /b 7\r\n', 'utf-8')

      const result = spawnSync('cmd.exe', ['/d', '/c', wrapWindowsHookCommand(scriptPath)], {
        env: { ...process.env, ORCA_WRAP_TEST: 'expanded' }
      })

      expect(result.status).toBe(7)
    }
  )
})

describe('wrapWindowsCmdHookCommand', () => {
  it('returns the bare, directly-spawnable path for a cmd-safe managed script', () => {
    // Why: Codex/Antigravity/Devin launch the command as a program (argv[0]),
    // not via cmd.exe, so the launcher must be a single spawnable token — a bare
    // .cmd path. A cmd-builtin `if …` launcher has argv[0] = `if`, which is
    // unspawnable and fails every hook with exit 1 (#8430 regression).
    const scriptPath = 'C:\\Users\\alice\\.orca\\agent-hooks\\codex-hook.cmd'
    const command = wrapWindowsCmdHookCommand(scriptPath)
    expect(command).toBe(scriptPath)
    expect(command).not.toMatch(/^if\b/)
    expect(command).not.toMatch(/powershell/i)
  })

  it.skipIf(process.platform !== 'win32')(
    'resolves the launcher to a real executable file, not a shell fragment',
    () => {
      // Regression guard for #8430: Codex/Antigravity/Devin spawn the launcher as
      // a program (argv[0]), so it must be an existing, launchable file. The broken
      // `if exist … (call …)` form had argv[0] = `if` — a cmd builtin, not a file —
      // which is unspawnable and failed every hook. The bare path is the file.
      // win32-only: the real temp path is cmd-safe only with backslashes; a POSIX
      // tmpDir has `/`, which routes to the encoded fallback by design.
      const scriptPath = join(tmpDir, 'codex-hook.cmd')
      writeFileSync(scriptPath, '@echo off\r\nexit /b 0\r\n', 'utf-8')
      const command = wrapWindowsCmdHookCommand(scriptPath)
      expect(command).toBe(scriptPath)
      expect(existsSync(command)).toBe(true)
    }
  )

  it('falls back to the encoded launcher when cmd.exe would split or expand the path', () => {
    const scriptPath = 'C:\\Users\\Jane Doe\\%ORCA_TEST%\\codex-hook.cmd'
    const command = wrapWindowsCmdHookCommand(scriptPath)
    expect(command).toMatch(qualifiedWindowsPowerShellCommand)
    expect(decodeWindowsHookCommand(command)).toBe(expectedDecodedWindowsHookCommand(scriptPath))
  })
})

describe('wrapWindowsGitBashHookCommand', () => {
  it('guards the forward-slash fast path and drains when missing', () => {
    expect(
      wrapWindowsGitBashHookCommand('C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd')
    ).toBe(
      "if [ -f 'C:/Users/alice/.orca/agent-hooks/claude-hook.cmd' ]; then 'C:/Users/alice/.orca/agent-hooks/claude-hook.cmd'; else cat >/dev/null 2>&1 || :; fi"
    )
  })

  it('falls back to the encoded launcher when bash would split the path', () => {
    const scriptPath = 'C:\\Users\\Jane Doe\\.orca\\agent-hooks\\claude-hook.cmd'
    const command = wrapWindowsGitBashHookCommand(scriptPath)
    expect(command).toMatch(qualifiedWindowsPowerShellCommand)
    expect(decodeWindowsHookCommand(command)).toBe(expectedDecodedWindowsHookCommand(scriptPath))
  })

  it('falls back to the encoded launcher when bash metacharacters are present', () => {
    const scriptPath = 'C:\\Users\\alice & bob\\.orca\\agent-hooks\\claude-hook.cmd'
    const command = wrapWindowsGitBashHookCommand(scriptPath)
    expect(command).toMatch(qualifiedWindowsPowerShellCommand)
    expect(command).not.toContain('& bob')
    expect(decodeWindowsHookCommand(command)).toBe(expectedDecodedWindowsHookCommand(scriptPath))
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

describe('buildWindowsAgentHookCurlPostCommand', () => {
  it('posts form fields via curl.exe and reads the payload from stdin', () => {
    const command = buildWindowsAgentHookCurlPostCommand('codex')

    // Why: the fast path must not spawn a second PowerShell; that startup cost
    // is the regression this replaces.
    expect(command).not.toMatch(/powershell/i)
    expect(command).toContain('%SystemRoot%\\System32\\curl.exe')
    expect(command).toContain('http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/codex')
    expect(command).toContain('-H "Content-Type: application/x-www-form-urlencoded"')
    expect(command).toContain('-H "X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%"')
    expect(command).toContain('--data-urlencode "paneKey=%ORCA_PANE_KEY%"')
    expect(command).toContain('--data-urlencode "worktreeId=%ORCA_WORKTREE_ID%"')
    // Why: `payload@-` makes curl read raw bytes from stdin and urlencode them,
    // so UTF-8 prompts survive without a code-page conversion.
    expect(command).toContain('--data-urlencode "payload@-"')
    // Why: same dead-listener bound as the POSIX hook so a stalled server can't
    // hold up the agent.
    expect(command).toContain('--connect-timeout 0.5 --max-time 1.5')
  })

  it('targets the requested hook source endpoint', () => {
    expect(buildWindowsAgentHookCurlPostCommand('grok')).toContain('/hook/grok')
  })
})
