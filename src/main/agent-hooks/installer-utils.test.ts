import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
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

describe('writeHooksJson', () => {
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
    // Why: wrapPosixHookCommand wraps the launcher in `if [ -x ... ]; then ...; fi`
    // so a stale entry no-ops instead of returning exit 127. The sweep on
    // install() must still recognize the guarded form as managed, otherwise
    // repeated installs would accumulate one guarded + one unguarded entry.
    expect(
      match(
        'if [ -x "/Users/alice/Library/Application Support/Orca/agent-hooks/claude-hook.sh" ]; then /bin/sh "/Users/alice/Library/Application Support/Orca/agent-hooks/claude-hook.sh"; fi'
      )
    ).toBe(true)
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
    expect(cmd).toBe("if [ -x '/does/not/exist.sh' ]; then /bin/sh '/does/not/exist.sh'; fi")
  })

  it('preserves spaces in the script path (Library/Application Support case)', () => {
    // Why: Electron's userData on macOS lives under "Application Support" with
    // a space. The guard must keep the path quoted so `[ -x ]` and `/bin/sh`
    // each see one argument.
    const cmd = wrapPosixHookCommand('/Users/a/Library/Application Support/Orca/agent-hooks/x.sh')
    expect(cmd).toContain("'/Users/a/Library/Application Support/Orca/agent-hooks/x.sh'")
  })

  it('escapes embedded single quotes so the wrapped command stays well-formed', () => {
    // Why: POSIX single-quote escape renders ' as '\''. Verify a path with an
    // embedded quote does not break out of the quoting and instead reaches
    // /bin/sh as a single argument.
    const cmd = wrapPosixHookCommand("/path/with'quote/x.sh")
    expect(cmd).toBe(
      "if [ -x '/path/with'\\''quote/x.sh' ]; then /bin/sh '/path/with'\\''quote/x.sh'; fi"
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
