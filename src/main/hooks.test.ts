/* eslint-disable max-lines -- Why: hook parsing, shell selection, and execution-path regressions are tightly coupled, so these cases stay in one file to preserve the behavior matrix across platforms. */
import type { Repo } from '../shared/types'

import { describe, expect, it, vi } from 'vitest'
import { parseOrcaYaml } from './hooks'

// Mock fs and path used by loadHooks
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn()
}))

const { execMock, execFileMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execFileMock: vi.fn()
}))

vi.mock('child_process', () => ({
  exec: execMock,
  execFile: execFileMock,
  execFileSync: vi.fn(),
  // runner.ts imports spawn from child_process transitively.
  spawn: vi.fn()
}))

describe('parseOrcaYaml', () => {
  it('parses YAML with setup script only', () => {
    const yaml = `scripts:\n  setup: |\n    echo "setting up"\n    npm install\n`
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        setup: 'echo "setting up"\nnpm install'
      }
    })
  })

  it('parses YAML with archive script only', () => {
    const yaml = `scripts:\n  archive: |\n    echo "archiving"\n`
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        archive: 'echo "archiving"'
      }
    })
  })

  it('parses YAML with both setup and archive', () => {
    const yaml = [
      'scripts:',
      '  setup: |',
      '    echo "setup"',
      '    npm install',
      '  archive: |',
      '    echo "archive"',
      '    rm -rf node_modules'
    ].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        setup: 'echo "setup"\nnpm install',
        archive: 'echo "archive"\nrm -rf node_modules'
      }
    })
  })

  it('returns null when there is no scripts block', () => {
    const yaml = `other:\n  key: value\n`
    expect(parseOrcaYaml(yaml)).toBeNull()
  })

  it('parses YAML with inline scalar scripts', () => {
    const yaml = `scripts:\n  setup: npm install\n  archive: sleep 5\n`
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        setup: 'npm install',
        archive: 'sleep 5'
      }
    })
  })

  it('returns null when scripts block has no setup or archive', () => {
    const yaml = `scripts:\n  unknown: |\n    echo "nope"\n`
    expect(parseOrcaYaml(yaml)).toBeNull()
  })

  it('handles multiline block scalar scripts', () => {
    const yaml = ['scripts:', '  setup: |', '    line1', '    line2', '    line3'].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        setup: 'line1\nline2\nline3'
      }
    })
  })

  it('stops parsing when it hits another top-level key', () => {
    const yaml = ['scripts:', '  setup: |', '    echo "setup"', 'other:', '  key: value'].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        setup: 'echo "setup"'
      }
    })
  })

  it('returns null for empty string', () => {
    expect(parseOrcaYaml('')).toBeNull()
  })

  it('parses a top-level issueCommand block scalar', () => {
    const yaml = [
      'issueCommand: |',
      '  claude -p "Read issue #{{issue}}"',
      '  codex exec "Review docs/design-{{issue}}.md"'
    ].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {},
      issueCommand:
        'claude -p "Read issue #{{issue}}"\ncodex exec "Review docs/design-{{issue}}.md"'
    })
  })

  it('parses issueCommand alongside scripts', () => {
    const yaml = [
      'scripts:',
      '  setup: |',
      '    pnpm install',
      'issueCommand: |',
      '  claude -p "Read issue #{{issue}}"'
    ].join('\n')
    const result = parseOrcaYaml(yaml)
    expect(result).toEqual({
      scripts: {
        setup: 'pnpm install'
      },
      issueCommand: 'claude -p "Read issue #{{issue}}"'
    })
  })
})

describe('hasUnrecognizedOrcaYamlKeys', () => {
  it('returns true when the file contains only keys this version does not handle', async () => {
    const fs = await import('fs')
    vi.mocked(fs.readFileSync).mockReturnValue('futureFeature: |\n  some config\n')

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(true)
  })

  it('returns true when an unknown key has no trailing space (block-value form)', async () => {
    const fs = await import('fs')
    vi.mocked(fs.readFileSync).mockReturnValue('futureFeature:\n  nested: value\n')

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(true)
  })

  it('returns true when the file mixes recognised and unrecognised keys', async () => {
    const fs = await import('fs')
    vi.mocked(fs.readFileSync).mockReturnValue(
      'scripts:\n  setup: |\n    pnpm install\nnewFeature: enabled\n'
    )

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(true)
  })

  it('returns false when the file contains only recognised keys', async () => {
    const fs = await import('fs')
    vi.mocked(fs.readFileSync).mockReturnValue(
      'scripts:\n  setup: |\n    pnpm install\nissueCommand: |\n  claude -p "test"\n'
    )

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(false)
  })

  it('returns false when the file is empty or has no top-level keys', async () => {
    const fs = await import('fs')
    vi.mocked(fs.readFileSync).mockReturnValue('# just a comment\n')

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(false)
  })

  it('returns false when the file cannot be read', async () => {
    const fs = await import('fs')
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(false)
  })
})

describe('readIssueCommand', () => {
  it('prefers the local override over the shared orca.yaml command', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === '/test/repo/.orca/issue-command' || path === '/test/repo/orca.yaml'
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/.orca/issue-command') {
        return 'local command\n'
      }
      if (path === '/test/repo/orca.yaml') {
        return 'issueCommand: |\n  shared command\n'
      }
      return ''
    })

    const { readIssueCommand } = await import('./hooks')
    expect(readIssueCommand('/test/repo')).toEqual({
      localContent: 'local command',
      sharedContent: 'shared command',
      effectiveContent: 'local command',
      localFilePath: '/test/repo/.orca/issue-command',
      source: 'local'
    })
  })

  it('falls back to the shared orca.yaml command when no local override exists', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === '/test/repo/orca.yaml')
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/orca.yaml') {
        return 'issueCommand: |\n  shared command\n'
      }
      return ''
    })

    const { readIssueCommand } = await import('./hooks')
    expect(readIssueCommand('/test/repo')).toEqual({
      localContent: null,
      sharedContent: 'shared command',
      effectiveContent: 'shared command',
      localFilePath: '/test/repo/.orca/issue-command',
      source: 'shared'
    })
  })
})

describe('writeIssueCommand', () => {
  it('writes only the local override file and keeps .orca ignored locally', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === '/test/repo/.gitignore' || path === '/test/repo/.orca'
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/.gitignore') {
        return 'node_modules/\n'
      }
      return ''
    })

    const { writeIssueCommand } = await import('./hooks')
    writeIssueCommand('/test/repo', 'local command')

    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      '/test/repo/.gitignore',
      'node_modules/\n.orca\n',
      'utf-8'
    )
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      '/test/repo/.orca/issue-command',
      'local command\n',
      'utf-8'
    )
  })

  it('deletes the local override when the override is cleared', async () => {
    const fs = await import('fs')
    const { writeIssueCommand } = await import('./hooks')
    writeIssueCommand('/test/repo', '   ')

    expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith('/test/repo/.orca/issue-command', {
      force: true
    })
  })
})

describe('getEffectiveHooks', () => {
  // We need to dynamically import after mocking
  const makeRepo = (hookSettings?: {
    mode?: 'auto' | 'override'
    setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default'
    scripts?: { setup: string; archive: string }
  }) =>
    ({
      id: 'test-id',
      path: '/test/repo',
      displayName: 'Test Repo',
      badgeColor: '#000',
      addedAt: Date.now(),
      hookSettings
    }) as unknown as Repo

  it('uses hooks from orca.yaml when present', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo "yaml setup"\n')

    // Re-import to pick up mocks
    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo()
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "yaml setup"'
      }
    })
  })

  it("loads setup hooks from the target worktree's orca.yaml when a worktree path is provided", async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === '/test/repo/orca.yaml' || path === '/test/worktree/orca.yaml'
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === '/test/repo/orca.yaml') {
        return 'scripts:\n  setup: |\n    echo old-version\n'
      }
      if (path === '/test/worktree/orca.yaml') {
        return 'scripts:\n  setup: |\n    echo new-version\n'
      }
      return ''
    })

    const { getEffectiveHooks } = await import('./hooks')
    const result = getEffectiveHooks(makeRepo(), '/test/worktree')

    expect(result).toEqual({
      scripts: {
        setup: 'echo new-version'
      }
    })
    expect(result?.scripts.setup).not.toContain('old-version')
  })

  it('falls back to legacy UI hooks when yaml is missing', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy ui setup"', archive: 'echo "legacy archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "legacy ui setup"',
        archive: 'echo "legacy archive"'
      }
    })
  })

  it('ignores legacy UI override settings when yaml exists', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo "yaml setup"\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "ui override"', archive: '' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "yaml setup"'
      }
    })
  })

  it('falls back per hook when orca.yaml defines only one command', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  archive: |\n    echo "yaml archive"\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy setup"', archive: 'echo "legacy archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "legacy setup"',
        archive: 'echo "yaml archive"'
      }
    })
  })

  it('returns null when no hooks at all', async () => {
    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({ mode: 'auto', scripts: { setup: '', archive: '' } })
    const result = getEffectiveHooks(repo)

    expect(result).toBeNull()
  })
})

describe('runHook', () => {
  const makeRepo = (hookSettings?: {
    mode?: 'auto' | 'override'
    setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default'
    scripts?: { setup: string; archive: string }
  }) =>
    ({
      id: 'test-id',
      path: '/test/repo',
      displayName: 'Test Repo',
      badgeColor: '#000',
      addedAt: Date.now(),
      hookSettings
    }) as unknown as Repo

  it('uses the Windows command shell when running hooks', async () => {
    execMock.mockImplementation((_script, _options, callback) => {
      callback?.(null, '', '')
      return {} as never
    })

    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    const originalComSpec = process.env.ComSpec

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'

    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('setup', 'C:\\repo\\worktree', makeRepo())

      expect(result).toEqual({ success: true, output: '' })
      expect(execMock).toHaveBeenCalledWith(
        'echo hello',
        expect.objectContaining({
          cwd: 'C:\\repo\\worktree',
          shell: 'C:\\Windows\\System32\\cmd.exe'
        }),
        expect.any(Function)
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalComSpec === undefined) {
        delete process.env.ComSpec
      } else {
        process.env.ComSpec = originalComSpec
      }
    }
  })

  it('keeps bash as the hook shell on non-Windows platforms', async () => {
    execMock.mockImplementation((_script, _options, callback) => {
      callback?.(null, '', '')
      return {} as never
    })

    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    const originalShell = process.env.SHELL

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux'
    })
    process.env.SHELL = '/opt/homebrew/bin/fish'

    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('setup', '/repo/worktree', makeRepo())

      expect(result).toEqual({ success: true, output: '' })
      expect(execMock).toHaveBeenCalledWith(
        'echo hello',
        expect.objectContaining({
          cwd: '/repo/worktree',
          shell: '/bin/bash'
        }),
        expect.any(Function)
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })

  it('runs WSL hooks through wsl.exe and translates env paths to Linux', async () => {
    execMock.mockReset()
    execFileMock.mockReset()
    execFileMock.mockImplementation((_file, _args, options, callback) => {
      callback?.(null, '', '')
      expect(options).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            ORCA_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
            ORCA_WORKTREE_PATH: '/home/jin/feature',
            CONDUCTOR_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
            GHOSTX_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca'
          })
        })
      )
      return {} as never
    })

    const fs = await import('fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('setup', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\feature', {
        ...makeRepo(),
        path: 'C:\\Users\\jinwo\\git\\orca'
      })

      expect(result).toEqual({ success: true, output: '' })
      expect(execFileMock).toHaveBeenCalledWith(
        'wsl.exe',
        ['-d', 'Ubuntu', '--', 'bash', '-c', "cd '/home/jin/feature' && echo hello"],
        expect.any(Object),
        expect.any(Function)
      )
      expect(execMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })
})

describe('shouldRunSetupForCreate', () => {
  const makeRepo = (setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default') =>
    ({
      id: 'test-id',
      path: '/test/repo',
      displayName: 'Test Repo',
      badgeColor: '#000',
      addedAt: Date.now(),
      hookSettings: {
        mode: 'auto',
        setupRunPolicy,
        scripts: { setup: '', archive: '' }
      }
    }) as unknown as Repo

  it('requires an explicit decision when the repo policy is ask', async () => {
    const { shouldRunSetupForCreate } = await import('./hooks')

    expect(() => shouldRunSetupForCreate(makeRepo('ask'))).toThrow(
      'Setup decision required for this repository'
    )
  })

  it('uses the repo default when the caller inherits', async () => {
    const { shouldRunSetupForCreate } = await import('./hooks')

    expect(shouldRunSetupForCreate(makeRepo('run-by-default'))).toBe(true)
    expect(shouldRunSetupForCreate(makeRepo('skip-by-default'))).toBe(false)
  })

  it('lets the caller override the repo default per create', async () => {
    const { shouldRunSetupForCreate } = await import('./hooks')

    expect(shouldRunSetupForCreate(makeRepo('skip-by-default'), 'run')).toBe(true)
    expect(shouldRunSetupForCreate(makeRepo('run-by-default'), 'skip')).toBe(false)
  })
})
