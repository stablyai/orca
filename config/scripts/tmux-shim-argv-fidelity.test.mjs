// Integration tests for the tmux.exe shim on Windows.
//
// ## CI coverage decision
//
// These tests are skipped on all CI hosts (ubuntu, macos, windows-latest) because
// two test scenarios require a full Orca installation:
//   - "forwards argv to a direct executable" — needs Orca.exe adjacent to the stub exe
//   - "tmux pane format strings arrive intact" — same constraint
//
// The three scenarios that run in CI:
//   - "bare-name spawn reaches shim, not decoy"   (shell:false)
//   - "shell:true also reaches the shim"
//   - "returns 1 when shim bin does not exist"
//
// To add CI regression coverage for the argv-fidelity scenarios, a windows-2022 job
// would need to install Orca first (e.g. download and run the installer) so that
// `Orca.exe` is available next to the stub. That installation step is new
// infrastructure and is not included in this PR.
//
// These tests are still useful to developers: run `pnpm run build:windows-shims`
// before executing them.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')

function itWindows(name, test) {
  const runner = process.platform === 'win32' ? it : it.skip
  runner(name, { timeout: 20_000 }, test)
}

// Path to the built tmux shim. Requires `pnpm run build:windows-shims` first.
function tmuxShimPath() {
  const devPath = resolve(projectRoot, 'native/windows-cli-launcher/.build/tmux.exe')
  if (existsSync(devPath)) return devPath
  return null
}

// Compile a C# source file to an exe using the build script, then return the path.
function buildStubExe(stubRoot, stubName, sourceContent) {
  const srcPath = join(stubRoot, `${stubName}.cs`)
  const exePath = join(stubRoot, `${stubName}.exe`)
  writeFileSync(srcPath, sourceContent, 'utf8')
  const build = spawnSync(process.execPath, [
    'config/scripts/build-windows-cli-launcher.mjs',
    '--target', 'orca', '--output', exePath
  ], { cwd: projectRoot, encoding: 'utf8' })
  if (build.status !== 0) throw new Error(`stub build failed: ${build.stderr}`)
  return exePath
}

describe('tmux shim argv fidelity', () => {
  describe('wins bare-name lookup against competing tmux', () => {
    itWindows('bare-name spawn of tmux -V reaches Orca shim, not a decoy', () => {
      const shimPath = tmuxShimPath()
      if (!shimPath) {
        throw new Error(
          'tmux.exe not found at native/windows-cli-launcher/.build/tmux.exe — run `pnpm run build:windows-shims` first'
        )
      }

      // Build a decoy that exits with code 99.
      const decoyRoot = mkdtempSync(join(tmpdir(), 'orca-decoy-tmux-'))
      try {
        buildStubExe(decoyRoot, 'decoy', `
using System;
class Decoy {
  static void Main() {
    Console.Error.WriteLine("DECOY_WINS");
    Environment.Exit(99);
  }
}`)

        // Shim dir with the real shim first on PATH.
        const shimDir = mkdtempSync(join(tmpdir(), 'orca-shim-precedence-'))
        const shimBinDir = join(shimDir, 'bin')
        const { mkdirSync } = require('node:fs')
        mkdirSync(shimBinDir, { recursive: true })
        copyFileSync(shimPath, join(shimBinDir, 'tmux.exe'))

        // PATH: shim dir first, then decoy dir.
        const pathWithShimFirst = `${shimBinDir};${decoyRoot}`

        // shell:false = bare-name spawn (exactly what Node's child_process.spawn('tmux') does).
        const result = spawnSync('tmux', ['-V'], {
          env: { ...process.env, PATH: pathWithShimFirst, ORCA_AGENT_TEAMS_SHIM_BIN: 'echo' },
          shell: false,
          encoding: 'utf8'
        })

        // If decoy won, stderr would contain DECOY_WINS and exit code would be 99.
        expect(result.stderr).not.toContain('DECOY_WINS')
        expect(result.status).not.toBe(99)
      } finally {
        rmSync(decoyRoot, { recursive: true, force: true })
      }
    })

    itWindows('shell: true also reaches the shim', () => {
      const shimPath = tmuxShimPath()
      if (!shimPath) {
        throw new Error('tmux.exe not found — run `pnpm run build:windows-shims` first')
      }

      const decoyRoot = mkdtempSync(join(tmpdir(), 'orca-decoy-st-'))
      try {
        buildStubExe(decoyRoot, 'decoy', `
using System;
class Decoy {
  static void Main() { Environment.Exit(99); }
}`)

        const shimDir = mkdtempSync(join(tmpdir(), 'orca-shim-st-'))
        const shimBinDir = join(shimDir, 'bin')
        const { mkdirSync } = require('node:fs')
        mkdirSync(shimBinDir, { recursive: true })
        copyFileSync(shimPath, join(shimBinDir, 'tmux.exe'))

        const pathWithShimFirst = `${shimBinDir};${decoyRoot}`

        const result = spawnSync('tmux', ['-V'], {
          env: { ...process.env, PATH: pathWithShimFirst, ORCA_AGENT_TEAMS_SHIM_BIN: 'echo' },
          shell: true,
          encoding: 'utf8'
        })

        expect(result.status).not.toBe(99)
      } finally {
        rmSync(decoyRoot, { recursive: true, force: true })
      }
    })
  })

  describe('returns child exit code', () => {
    itWindows('returns 1 when ORCA_AGENT_TEAMS_SHIM_BIN does not exist', () => {
      const shimPath = tmuxShimPath()
      if (!shimPath) {
        throw new Error('tmux.exe not found — run `pnpm run build:windows-shims` first')
      }

      const result = spawnSync(shimPath, ['agent-teams-tmux', '-V'], {
        env: { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: 'C:\\nonexistent\\orca.cmd' },
        encoding: 'utf8'
      })

      // Should fail with exit code 1 and write a reason to stderr.
      expect(result.status).toBe(1)
      expect(result.stderr.length, 'stderr should contain a reason').toBeGreaterThan(0)
    })

    itWindows('forwards argv to a direct executable without cmd.exe re-parsing', () => {
      // This tests the shim → direct-executable handoff without a batch file in between.
      // When ORCA_AGENT_TEAMS_SHIM_BIN points to a compiled .exe (not .cmd), the shim
      // uses UseShellExecute=false and argv reaches the target byte-for-byte.
      const shimPath = tmuxShimPath()
      if (!shimPath) {
        throw new Error('tmux.exe not found — run `pnpm run build:windows-shims` first')
      }

      const stubRoot = mkdtempSync(join(tmpdir(), 'orca-shim-argv-direct-'))
      try {
        // Build a stub that logs what it received and exits 0.
        const stubExe = buildStubExe(stubRoot, 'echo-args', `
using System;
using System.IO;
class EchoArgs {
  static void Main(string[] args) {
    var logPath = Path.Combine(Path.GetDirectoryName(
      System.Reflection.Assembly.GetExecutingAssembly().Location), "args.txt");
    File.WriteAllText(logPath, string.Join("\\x00", args));
  }
}`)

        const argsFile = join(stubRoot, 'args.txt')
        if (existsSync(argsFile)) unlinkSync(argsFile)

        // These arguments would be mangled by cmd.exe %* re-parsing in a .cmd batch file.
        // When shim calls a direct .exe with UseShellExecute=false, they arrive intact.
        const dangerousArgs = [
          'hello&world', 'a|b', 'out>file', 'caret^is^here',
          'pct%is%dangerous', 'with spaces', 'and    tabs\twere\tpreserved'
        ]

        const result = spawnSync(shimPath, ['agent-teams-tmux', 'send-keys', '-t', '0', ...dangerousArgs], {
          env: { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: stubExe },
          cwd: stubRoot,
          encoding: 'utf8'
        })

        // Shim should return 0 when the forward succeeds.
        expect(result.status, `shim exited non-zero: ${result.stderr}`).toBe(0)

        // The stub should have received every argument byte-for-byte.
        const echoed = existsSync(argsFile)
          ? readFileSync(argsFile, 'utf8').split('\x00')
          : []
        expect(echoed).toEqual(dangerousArgs)
      } finally {
        rmSync(stubRoot, { recursive: true, force: true })
      }
    })

    itWindows('tmux pane format strings arrive intact through the direct executable path', () => {
      // Regression test: display-message with '#{pane_id}|#{session_name}' failed when
      // orca.cmd re-parsed '|' as a cmd.exe pipe operator via %*.
      // With a direct .exe shim target, '|' arrives intact.
      const shimPath = tmuxShimPath()
      if (!shimPath) {
        throw new Error('tmux.exe not found — run `pnpm run build:windows-shims` first')
      }

      const stubRoot = mkdtempSync(join(tmpdir(), 'orca-shim-pf-direct-'))
      try {
        const stubExe = buildStubExe(stubRoot, 'echo-pf', `
using System;
using System.IO;
class EchoPf {
  static void Main(string[] args) {
    var logPath = Path.Combine(Path.GetDirectoryName(
      System.Reflection.Assembly.GetExecutingAssembly().Location), "args.txt");
    File.WriteAllText(logPath, string.Join("\\x00", args));
  }
}`)

        const argsFile = join(stubRoot, 'args.txt')
        if (existsSync(argsFile)) unlinkSync(argsFile)

        const paneFormatArg = '#{pane_id}|#{session_name}'

        const result = spawnSync(
          shimPath,
          ['agent-teams-tmux', 'display-message', '-p', paneFormatArg],
          { env: { ...process.env, ORCA_AGENT_TEAMS_SHIM_BIN: stubExe }, cwd: stubRoot, encoding: 'utf8' }
        )

        expect(result.status, result.stderr).toBe(0)
        const echoed = existsSync(argsFile) ? readFileSync(argsFile, 'utf8').split('\x00') : []
        expect(echoed[0]).toBe('agent-teams-tmux')
        expect(echoed[1]).toBe('display-message')
        expect(echoed[2]).toBe('-p')
        expect(echoed[3]).toBe(paneFormatArg)
      } finally {
        rmSync(stubRoot, { recursive: true, force: true })
      }
    })
  })
})
