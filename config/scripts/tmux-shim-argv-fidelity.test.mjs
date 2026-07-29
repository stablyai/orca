// Integration tests for the Windows tmux.exe shim.
//
// Scope: these run only on win32 (the shim is a Windows PE). On a windows-2022/latest CI
// host they DO run; on ubuntu/macos they skip. They require the shim to be built first:
//   pnpm run build:windows-shims
//
// Each test compiles its own throwaway target with `--source`, so nothing here depends on
// an installed Orca.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')
const SHIM_PATH = resolve(projectRoot, 'native/windows-cli-launcher/.build/tmux.exe')

function itWindows(name, test) {
  const runner = process.platform === 'win32' ? it : it.skip
  runner(name, { timeout: 30_000 }, test)
}

function requireShim() {
  if (!existsSync(SHIM_PATH)) {
    throw new Error(`tmux.exe not found at ${SHIM_PATH} — run \`pnpm run build:windows-shims\` first`)
  }
  return SHIM_PATH
}

// Why: --source compiles exactly this file; --target would rebuild the real launcher instead.
function buildStub(root, name, source) {
  const sourcePath = join(root, `${name}.cs`)
  const exePath = join(root, `${name}.exe`)
  writeFileSync(sourcePath, source, 'utf8')
  const build = spawnSync(
    process.execPath,
    ['config/scripts/build-windows-cli-launcher.mjs', '--source', sourcePath, '--output', exePath],
    { cwd: projectRoot, encoding: 'utf8' }
  )
  if (build.status !== 0) {
    throw new Error(`stub build failed: ${build.stderr || build.stdout}`)
  }
  return exePath
}

// Records each received argument on its own line next to the executable, then exits 0.
const RECORDER_SOURCE = [
  'using System;',
  'using System.IO;',
  'using System.Reflection;',
  'internal static class Recorder {',
  '  private static int Main(string[] args) {',
  '    string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);',
  '    File.WriteAllLines(Path.Combine(dir, "received.txt"), args);',
  '    return 0;',
  '  }',
  '}'
].join('\n')

function exitCodeSource(code) {
  return [
    'using System;',
    'internal static class Exiter {',
    `  private static int Main(string[] args) { return ${code}; }`,
    '}'
  ].join('\n')
}

const DECOY_SOURCE = [
  'using System;',
  'internal static class Decoy {',
  '  private static int Main(string[] args) {',
  '    Console.Error.WriteLine("DECOY_WINS");',
  '    return 99;',
  '  }',
  '}'
].join('\n')

function readReceived(exePath) {
  const file = join(dirname(exePath), 'received.txt')
  if (!existsSync(file)) {
    return null
  }
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.length > 0)
}

function withTempRoots(count, run) {
  const roots = Array.from({ length: count }, () => mkdtempSync(join(tmpdir(), 'orca-tmux-shim-')))
  try {
    return run(...roots)
  } finally {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('windows tmux shim', () => {
  describe('PATH precedence over a competing tmux', () => {
    for (const useShell of [false, true]) {
      itWindows(`bare-name tmux resolves to the shim, not a decoy (shell: ${useShell})`, () => {
        requireShim()
        withTempRoots(3, (shimDir, decoyDir, recorderRoot) => {
          const recorder = buildStub(recorderRoot, 'recorder', RECORDER_SOURCE)
          buildStub(decoyDir, 'decoy', DECOY_SOURCE)
          // The decoy has to be named tmux.exe to actually compete for the bare name.
          mkdirSync(shimDir, { recursive: true })
          writeFileSync(join(shimDir, 'tmux.exe'), readFileSync(SHIM_PATH))
          writeFileSync(join(decoyDir, 'tmux.exe'), readFileSync(join(decoyDir, 'decoy.exe')))

          const result = spawnSync('tmux', ['-V'], {
            env: {
              ...process.env,
              PATH: `${shimDir};${decoyDir}`,
              ORCA_AGENT_TEAMS_SHIM_BIN: recorder
            },
            shell: useShell,
            encoding: 'utf8'
          })

          // Positive assertion: Orca's shim ran AND forwarded. A negative-only check
          // would pass even if the shim were an empty program.
          expect(readReceived(recorder)).toEqual(['agent-teams-tmux', '-V'])
          expect(result.stderr ?? '').not.toContain('DECOY_WINS')
          expect(result.status).toBe(0)
        })
      })
    }
  })

  describe('argument fidelity', () => {
    itWindows('forwards shell metacharacters to a direct executable byte-for-byte', () => {
      const shim = requireShim()
      withTempRoots(1, (root) => {
        const recorder = buildStub(root, 'recorder', RECORDER_SOURCE)
        const dangerous = [
          'hello&world',
          'a|b',
          'out>file',
          'caret^is^here',
          'with spaces',
          'quote"inside',
          'trailing\\backslash'
        ]

        const result = spawnSync(shim, ['send-keys', '-t', '%1', ...dangerous], {
          env: { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: recorder },
          encoding: 'utf8'
        })

        expect(result.status, result.stderr).toBe(0)
        expect(readReceived(recorder)).toEqual(['agent-teams-tmux', 'send-keys', '-t', '%1', ...dangerous])
      })
    })

    itWindows('tmux pane format strings survive the hop', () => {
      // Regression: display-message with '#{pane_id}|#{session_name}' died when the
      // batch shim let cmd.exe read the '|' as a pipe.
      const shim = requireShim()
      withTempRoots(1, (root) => {
        const recorder = buildStub(root, 'recorder', RECORDER_SOURCE)
        const paneFormat = '#{pane_id}|#{session_name}'

        const result = spawnSync(shim, ['display-message', '-p', paneFormat], {
          env: { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: recorder },
          encoding: 'utf8'
        })

        expect(result.status, result.stderr).toBe(0)
        expect(readReceived(recorder)).toEqual([
          'agent-teams-tmux',
          'display-message',
          '-p',
          paneFormat
        ])
      })
    })

    itWindows('reaches a batch-file shim bin through cmd.exe', () => {
      // The dev path resolves ORCA_AGENT_TEAMS_SHIM_BIN to orca-dev.cmd, which
      // CreateProcess cannot launch directly.
      const shim = requireShim()
      withTempRoots(1, (root) => {
        const marker = join(root, 'batch-received.txt')
        const batchPath = join(root, 'shim-bin.cmd')
        // %~1 strips the quoting the cmd branch adds, matching how orca.cmd reads its own argv.
        writeFileSync(batchPath, `@echo off\r\n>"${marker}" echo %~1 %~2\r\n`, 'utf8')

        const result = spawnSync(shim, ['list-panes'], {
          env: { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: batchPath },
          encoding: 'utf8'
        })

        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(marker), 'batch shim bin was never invoked').toBe(true)
        expect(readFileSync(marker, 'utf8').trim()).toBe('agent-teams-tmux list-panes')
      })
    })

    itWindows('an embedded quote cannot start a new command on the batch path', () => {
      // Regression: cmd.exe ignores CRT's \" escape, so a quote used to close cmd's quoted
      // region and leave the following & | > as operators (BatBadBut / CVE-2024-24576).
      const shim = requireShim()
      withTempRoots(1, (root) => {
        const recorder = buildStub(root, 'recorder', RECORDER_SOURCE)
        const injected = join(root, 'injected.txt')
        const batchPath = join(root, 'shim-bin.cmd')
        writeFileSync(batchPath, `@echo off\r\n"${recorder}" %*\r\n`, 'utf8')

        const hostile = [
          `a"&echo owned>"${injected}`,
          'quote"inside&other',
          'plain&meta|pipe>redir',
          'caret^here',
          'trailing\\backslash',
          '#{pane_id}|#{session_name}'
        ]

        const result = spawnSync(shim, ['send-keys', '-t', '%1', ...hostile], {
          env: { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: batchPath },
          encoding: 'utf8'
        })

        expect(existsSync(injected), 'argument broke out and ran a second command').toBe(false)
        expect(result.status, result.stderr).toBe(0)
        expect(readReceived(recorder)).toEqual([
          'agent-teams-tmux',
          'send-keys',
          '-t',
          '%1',
          ...hostile
        ])
      })
    })

    itWindows('refuses a %NAME% reference on the batch path but keeps tmux pane ids', () => {
      // cmd expands %NAME% AFTER quoting, so a variable whose value holds a quote escapes the
      // quoted region — measured: a value of INJECTED"&whoami ran whoami. %1/%99 are tmux pane
      // ids, not variable references, and must keep working.
      const shim = requireShim()
      withTempRoots(1, (root) => {
        const recorder = buildStub(root, 'recorder', RECORDER_SOURCE)
        const batchPath = join(root, 'shim-bin.cmd')
        writeFileSync(batchPath, `@echo off\r\n"${recorder}" %*\r\n`, 'utf8')
        const env = { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: batchPath }

        // The modifier forms matter as much as the plain one: cmd expands %PATH:~0,1% and
        // %PATH:a=b% too, and a name-characters-only scan walks straight past them.
        for (const hostile of ['%PATH%', '%PATH:~0,1%', '%PATH:x=y%', '%_x%']) {
          const refused = spawnSync(shim, ['send-keys', '-t', '%1', hostile], {
            env,
            encoding: 'utf8'
          })
          expect(refused.status, `expected ${hostile} to be refused`).toBe(1)
          expect(refused.stderr).toContain('%NAME%')
        }

        const allowed = spawnSync(shim, ['send-keys', '-t', '%1', '%99', '100%'], {
          env,
          encoding: 'utf8'
        })
        expect(allowed.status, allowed.stderr).toBe(0)
        expect(readReceived(recorder)).toEqual([
          'agent-teams-tmux',
          'send-keys',
          '-t',
          '%1',
          '%99',
          '100%'
        ])
      })
    })

    itWindows('forwards a %NAME% reference unchanged to a direct executable target', () => {
      // The packaged path is unaffected by the batch restriction.
      const shim = requireShim()
      withTempRoots(1, (root) => {
        const recorder = buildStub(root, 'recorder', RECORDER_SOURCE)
        const result = spawnSync(shim, ['send-keys', '%PATH%'], {
          env: { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: recorder },
          encoding: 'utf8'
        })
        expect(result.status, result.stderr).toBe(0)
        expect(readReceived(recorder)).toEqual(['agent-teams-tmux', 'send-keys', '%PATH%'])
      })
    })

    itWindows('refuses a line break on the batch path instead of splitting the command', () => {
      // cmd ends the command at a newline and no quoting suppresses it, so the only safe
      // answer is to refuse. Direct .exe targets forward line breaks fine.
      const shim = requireShim()
      withTempRoots(1, (root) => {
        const batchPath = join(root, 'shim-bin.cmd')
        writeFileSync(batchPath, '@echo off\r\nexit /b 0\r\n', 'utf8')

        const result = spawnSync(shim, ['send-keys', '-t', '%1', 'first\r\nsecond'], {
          env: { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: batchPath },
          encoding: 'utf8'
        })

        expect(result.status).toBe(1)
        expect(result.stderr).toContain('line breaks')
      })
    })
  })

  describe('exit codes', () => {
    itWindows('propagates the target exit code', () => {
      const shim = requireShim()
      withTempRoots(1, (root) => {
        const exiter = buildStub(root, 'exiter', exitCodeSource(42))
        const result = spawnSync(shim, ['-V'], {
          env: { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: exiter },
          encoding: 'utf8'
        })
        expect(result.status).toBe(42)
      })
    })

    itWindows('returns 1 with a reason when the shim bin does not exist', () => {
      const shim = requireShim()
      const result = spawnSync(shim, ['-V'], {
        env: { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: 'C:\\nonexistent\\orca.exe' },
        encoding: 'utf8'
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Unable to start the Orca tmux shim')
    })

    itWindows('does not print a fake version sentinel', () => {
      // The shim must stay transparent: `tmux -V` is answered by Orca's dispatcher,
      // not fabricated here, or every pane call pollutes stderr.
      const shim = requireShim()
      withTempRoots(1, (root) => {
        const recorder = buildStub(root, 'recorder', RECORDER_SOURCE)
        const result = spawnSync(shim, ['send-keys', '-t', '%1', 'hello'], {
          env: { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: recorder },
          encoding: 'utf8'
        })
        expect(result.stdout ?? '').not.toContain('tmux 3.4')
        expect(result.stderr ?? '').not.toContain('tmux 3.4')
      })
    })
  })
})
