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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import {
  createManagedCommandMatcher,
  removeManagedCommands,
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  writeManagedScript,
  writeHooksJson,
  type HooksConfig
} from './installer-utils'
import { buildPosixAgentHookPostCommand } from './hook-post-command'
import { wrapRuntimeHomeHookCommand } from './runtime-home-hook-command'

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'orca-installer-utils-test-'))
  configPath = join(tmpDir, 'settings.json')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
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

  it('cleans temporary output when writing to an existing directory fails', () => {
    const blockingDir = configPath
    mkdirSync(blockingDir)

    expect(() => writeHooksJson(blockingDir, { hooks: {} })).toThrow()

    const entries = readdirSync(tmpDir)
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0)
  })
})

describe('removeManagedCommands', () => {
  const match = createManagedCommandMatcher('copilot-hook.sh')

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

describe('wrapWindowsHookCommand', () => {
  // Gate events read silence as denial, so answer before a missing-context guard can exit.

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

  // Grok rejects unresolved bare variables even in untaken branches.

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
