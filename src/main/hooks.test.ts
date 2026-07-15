/* eslint-disable max-lines -- Why: hook parsing, shell selection, and execution-path regressions are tightly coupled, so these cases stay in one file to preserve the behavior matrix across platforms. */
import type { Repo } from '../shared/types'
import type * as GitRunner from './git/runner'

import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultTabsLaunch, parseOrcaYaml } from './hooks'

// Mock fs and path used by loadHooks
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn()
}))

const { execMock, execFileMock, gitExecFileSyncMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execFileMock: vi.fn(),
  gitExecFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  exec: execMock,
  execFile: execFileMock,
  execFileSync: vi.fn(),
  // runner.ts imports spawn from child_process transitively.
  spawn: vi.fn()
}))

vi.mock('./git/runner', async () => ({
  ...(await vi.importActual<typeof GitRunner>('./git/runner')),
  gitExecFileSync: gitExecFileSyncMock
}))

const TEST_REPO_PATH = join('/test/repo')
const TEST_WORKTREE_PATH = join('/test/worktree')
const TEST_REPO_ORCA_YAML_PATH = join(TEST_REPO_PATH, 'orca.yaml')
const TEST_WORKTREE_ORCA_YAML_PATH = join(TEST_WORKTREE_PATH, 'orca.yaml')
const TEST_ISSUE_COMMAND_PATH = join(TEST_REPO_PATH, '.orca', 'issue-command')
const TEST_GITIGNORE_PATH = join(TEST_REPO_PATH, '.gitignore')

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

  it('parses default terminal tabs from orca.yaml', () => {
    const yaml = [
      'defaultTabs:',
      '  - title: Claude',
      '    color: "#f97316"',
      '    command: claude',
      '  - title: LocalHost',
      '    color: "#9ca3af"',
      '    command: pnpm dev',
      '  - title: Notes'
    ].join('\n')

    expect(parseOrcaYaml(yaml)).toEqual({
      scripts: {},
      defaultTabs: [
        { title: 'Claude', color: '#f97316', command: 'claude' },
        { title: 'LocalHost', color: '#9ca3af', command: 'pnpm dev' },
        { title: 'Notes' }
      ]
    })
  })

  it('drops invalid default tab entries and unsafe color values', () => {
    const yaml = [
      'defaultTabs:',
      '  - title: Server',
      '    color: "red"',
      '    command: pnpm dev',
      '  - 42',
      '  - title: ""'
    ].join('\n')

    expect(parseOrcaYaml(yaml)).toEqual({
      scripts: {},
      defaultTabs: [{ title: 'Server', command: 'pnpm dev' }]
    })
  })

  it('parses environmentRecipes from orca.yaml', () => {
    const yaml = [
      'environmentRecipes:',
      '  - id: cloud-sandbox',
      '    name: Cloud Sandbox',
      '    description: Starts a per-workspace VM.',
      '    create: ./scripts/orca-vm/start-cloud-sandbox.sh',
      '    suspend: ./scripts/orca-vm/suspend-cloud-sandbox.sh',
      '    resume: ./scripts/orca-vm/resume-cloud-sandbox.sh',
      '    destroy: ./scripts/orca-vm/destroy-cloud-sandbox.sh'
    ].join('\n')

    expect(parseOrcaYaml(yaml)).toEqual({
      scripts: {},
      environmentRecipes: [
        {
          id: 'cloud-sandbox',
          name: 'Cloud Sandbox',
          description: 'Starts a per-workspace VM.',
          create: './scripts/orca-vm/start-cloud-sandbox.sh',
          suspend: './scripts/orca-vm/suspend-cloud-sandbox.sh',
          resume: './scripts/orca-vm/resume-cloud-sandbox.sh',
          destroy: './scripts/orca-vm/destroy-cloud-sandbox.sh'
        }
      ]
    })
  })

  it('parses legacy environmentRecipes command and cleanup aliases', () => {
    const yaml = [
      'environmentRecipes:',
      '  - id: manual-sandbox',
      '    name: Manual Sandbox',
      '    command: ./scripts/orca-vm/start-manual-sandbox.sh',
      '    cleanup: none'
    ].join('\n')

    expect(parseOrcaYaml(yaml)).toEqual({
      scripts: {},
      environmentRecipes: [
        {
          id: 'manual-sandbox',
          name: 'Manual Sandbox',
          create: './scripts/orca-vm/start-manual-sandbox.sh',
          destroyDisabled: true
        }
      ]
    })
  })

  it('drops invalid and duplicate environmentRecipes', () => {
    const yaml = [
      'environmentRecipes:',
      '  - id: cloud-sandbox',
      '    name: Cloud Sandbox',
      '    create: ./scripts/orca-vm/start-cloud-sandbox.sh',
      '  - id: cloud-sandbox',
      '    name: Duplicate Cloud Sandbox',
      '    create: ./scripts/orca-vm/start-duplicate.sh',
      '  - id: missing-create',
      '    name: Missing Create',
      '  - name: Missing Id',
      '    create: ./scripts/orca-vm/start-missing-id.sh',
      '  - id: "Cloud Sandbox"',
      '    name: Unsafe Id',
      '    create: ./scripts/orca-vm/start-unsafe-id.sh',
      '  - 42'
    ].join('\n')

    expect(parseOrcaYaml(yaml)).toEqual({
      scripts: {},
      environmentRecipes: [
        {
          id: 'cloud-sandbox',
          name: 'Cloud Sandbox',
          create: './scripts/orca-vm/start-cloud-sandbox.sh'
        }
      ],
      environmentRecipeDiagnostics: [
        {
          index: 1,
          field: 'id',
          message: 'Duplicate recipe id "cloud-sandbox". Recipe ids must be unique.'
        },
        { index: 2, field: 'create', message: 'Recipe "missing-create" is missing create.' },
        { index: 3, field: 'id', message: 'Recipe id is required.' },
        {
          index: 4,
          field: 'id',
          message:
            'Invalid recipe id "Cloud Sandbox". Use 1-64 lowercase letters, numbers, dots, underscores, or hyphens, starting with a letter or number.'
        },
        { index: 5, message: 'Recipe entry must be a mapping.' }
      ]
    })
  })
})

describe('hasUnrecognizedOrcaYamlKeys', () => {
  it('returns true when the file contains only keys this version does not handle', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue('futureFeature: |\n  some config\n')

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(true)
  })

  it('returns true when an unknown key has no trailing space (block-value form)', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue('futureFeature:\n  nested: value\n')

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(true)
  })

  it('returns true when the file mixes recognised and unrecognised keys', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(
      'scripts:\n  setup: |\n    pnpm install\nnewFeature: enabled\n'
    )

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(true)
  })

  it('returns false when the file contains only recognised keys', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        'scripts:',
        '  setup: |',
        '    pnpm install',
        'issueCommand: |',
        '  claude -p "test"',
        'defaultTabs:',
        '  - title: Claude',
        'environmentRecipes:',
        '  - id: cloud-sandbox',
        '    name: Cloud Sandbox',
        '    create: ./scripts/orca-vm/start-cloud-sandbox.sh'
      ].join('\n')
    )

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(false)
  })

  it('returns false when the file is empty or has no top-level keys', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue('# just a comment\n')

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(false)
  })

  it('returns false when the file cannot be read', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const { hasUnrecognizedOrcaYamlKeys } = await import('./hooks')
    expect(hasUnrecognizedOrcaYamlKeys('/test/repo')).toBe(false)
  })
})

describe('readIssueCommand', () => {
  it('prefers the local override over the shared orca.yaml command', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === TEST_ISSUE_COMMAND_PATH || path === TEST_REPO_ORCA_YAML_PATH
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === TEST_ISSUE_COMMAND_PATH) {
        return 'local command\n'
      }
      if (path === TEST_REPO_ORCA_YAML_PATH) {
        return 'issueCommand: |\n  shared command\n'
      }
      return ''
    })

    const { readIssueCommand } = await import('./hooks')
    expect(readIssueCommand(TEST_REPO_PATH)).toEqual({
      localContent: 'local command',
      sharedContent: 'shared command',
      effectiveContent: 'local command',
      localFilePath: TEST_ISSUE_COMMAND_PATH,
      source: 'local'
    })
  })

  it('falls back to the shared orca.yaml command when no local override exists', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation((path) => path === TEST_REPO_ORCA_YAML_PATH)
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === TEST_REPO_ORCA_YAML_PATH) {
        return 'issueCommand: |\n  shared command\n'
      }
      return ''
    })

    const { readIssueCommand } = await import('./hooks')
    expect(readIssueCommand(TEST_REPO_PATH)).toEqual({
      localContent: null,
      sharedContent: 'shared command',
      effectiveContent: 'shared command',
      localFilePath: TEST_ISSUE_COMMAND_PATH,
      source: 'shared'
    })
  })
})

describe('writeIssueCommand', () => {
  it('writes only the local override file and keeps .orca ignored locally', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === TEST_GITIGNORE_PATH || path === join(TEST_REPO_PATH, '.orca')
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === TEST_GITIGNORE_PATH) {
        return 'node_modules/\n'
      }
      return ''
    })

    const { writeIssueCommand } = await import('./hooks')
    writeIssueCommand(TEST_REPO_PATH, 'local command')

    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      TEST_GITIGNORE_PATH,
      'node_modules/\n.orca\n',
      'utf-8'
    )
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      TEST_ISSUE_COMMAND_PATH,
      'local command\n',
      'utf-8'
    )
  })

  it('deletes the local override when the override is cleared', async () => {
    const { writeIssueCommand } = await import('./hooks')
    const fs = await import('node:fs')
    writeIssueCommand(TEST_REPO_PATH, '   ')

    expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith(TEST_ISSUE_COMMAND_PATH, {
      force: true
    })
  })
})

describe('runner script builders', () => {
  it('builds Windows runners for newline-heavy scripts without line-array splitting', async () => {
    const { buildWindowsRunnerScript } = await import('./hooks')
    const script = `${'\r\n'.repeat(10_000)}pnpm install\r\nnpm run build\n`
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const replaceSpy = vi.spyOn(String.prototype, 'replace')

    try {
      const result = buildWindowsRunnerScript(script)

      expect(result.startsWith('@echo off\r\nsetlocal EnableExtensions\r\n')).toBe(true)
      expect(result).toContain('call pnpm install\r\nif errorlevel 1 exit /b %errorlevel%')
      expect(result).toContain('call npm run build\r\nif errorlevel 1 exit /b %errorlevel%')
      const usedLineSplit = splitSpy.mock.calls.some(
        ([separator]) =>
          (typeof separator === 'string' && separator === '\n') ||
          (separator instanceof RegExp && separator.source === '\\r?\\n')
      )
      const usedNewlineReplace = replaceSpy.mock.calls.some(
        ([pattern]) =>
          pattern instanceof RegExp && (pattern.source === '\\r?\\n' || pattern.source === '\\r\\n')
      )
      expect(usedLineSplit).toBe(false)
      expect(usedNewlineReplace).toBe(false)
    } finally {
      splitSpy.mockRestore()
      replaceSpy.mockRestore()
    }
  })

  it('builds POSIX runners without regex-wide CRLF normalization', async () => {
    const { buildPosixRunnerScript } = await import('./hooks')
    const script = `${'echo setup\r\n'.repeat(10_000)}echo done`
    const replaceSpy = vi.spyOn(String.prototype, 'replace')

    try {
      const result = buildPosixRunnerScript(script)

      expect(result.startsWith('#!/usr/bin/env bash\nset -e\necho setup\n')).toBe(true)
      expect(result.endsWith('echo done\n')).toBe(true)
      const usedCrlfReplace = replaceSpy.mock.calls.some(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '\\r\\n'
      )
      expect(usedCrlfReplace).toBe(false)
    } finally {
      replaceSpy.mockRestore()
    }
  })
})

describe('getEffectiveHooks', () => {
  // We need to dynamically import after mocking
  const makeRepo = (hookSettings?: {
    mode?: 'auto' | 'override'
    setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default'
    commandSourcePolicy?: 'shared-only' | 'local-only' | 'run-both'
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
    const fs = await import('node:fs')
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
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === TEST_REPO_ORCA_YAML_PATH || path === TEST_WORKTREE_ORCA_YAML_PATH
    )
    vi.mocked(fs.readFileSync).mockImplementation((path) => {
      if (path === TEST_REPO_ORCA_YAML_PATH) {
        return 'scripts:\n  setup: |\n    echo old-version\n'
      }
      if (path === TEST_WORKTREE_ORCA_YAML_PATH) {
        return 'scripts:\n  setup: |\n    echo new-version\n'
      }
      return ''
    })

    const { getEffectiveHooks } = await import('./hooks')
    const result = getEffectiveHooks(makeRepo(), TEST_WORKTREE_PATH)

    expect(result).toEqual({
      scripts: {
        setup: 'echo new-version'
      }
    })
    expect(result?.scripts.setup).not.toContain('old-version')
  })

  it('falls back to legacy local hooks when policy is unset and yaml is missing', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "local setup"', archive: 'echo "local archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "local setup"',
        archive: 'echo "local archive"'
      }
    })
  })

  it('does not fall back to local hooks when policy is explicitly shared-only', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      commandSourcePolicy: 'shared-only',
      scripts: { setup: 'echo "local setup"', archive: 'echo "local archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toBeNull()
  })

  it('uses local settings over shared yaml settings by default when local hooks exist', async () => {
    const fs = await import('node:fs')
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
        setup: 'echo "ui override"'
      }
    })
  })

  it('uses only local settings when command source policy is local-only', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo "yaml setup"\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      commandSourcePolicy: 'local-only',
      scripts: { setup: 'echo "local setup"', archive: '' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "local setup"'
      }
    })
  })

  it('runs yaml before local settings when command source policy is run-both', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo "yaml setup"\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      commandSourcePolicy: 'run-both',
      scripts: { setup: 'echo "local setup"', archive: '' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "yaml setup"\necho "local setup"'
      }
    })
  })

  it('uses local settings by default even when orca.yaml defines only one command', async () => {
    const fs = await import('node:fs')
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
        archive: 'echo "legacy archive"'
      }
    })
  })

  it('keeps shared setup when only archive has a legacy local script', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      'scripts:\n  setup: |\n    echo "yaml setup"\n  archive: |\n    echo "yaml archive"\n'
    )

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: '', archive: 'echo "legacy archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "yaml setup"',
        archive: 'echo "legacy archive"'
      }
    })
  })

  it('uses local settings by default when yaml exists without supported hooks', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('futureFeature: enabled\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy setup"', archive: 'echo "legacy archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        setup: 'echo "legacy setup"',
        archive: 'echo "legacy archive"'
      }
    })
  })

  it('treats legacy shared-first policy as orca.yaml only', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  archive: |\n    echo "yaml archive"\n')

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      commandSourcePolicy: 'shared-first' as never,
      scripts: { setup: 'echo "legacy setup"', archive: 'echo "legacy archive"' }
    })
    const result = getEffectiveHooks(repo)

    expect(result).toEqual({
      scripts: {
        archive: 'echo "yaml archive"'
      }
    })
  })

  it('returns null when no hooks at all', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getEffectiveHooks } = await import('./hooks')
    const repo = makeRepo({ mode: 'auto', scripts: { setup: '', archive: '' } })
    const result = getEffectiveHooks(repo)

    expect(result).toBeNull()
  })

  it('falls back to legacy local setup source only when yaml is missing', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getSetupCommandSource } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy setup"', archive: '' }
    })
    const result = getSetupCommandSource(repo)

    expect(result).toEqual({ source: 'local', command: 'echo "legacy setup"' })
  })

  it('uses local setup source by default when yaml omits setup', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  archive: |\n    echo "yaml archive"\n')

    const { getSetupCommandSource } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy setup"', archive: '' }
    })
    const result = getSetupCommandSource(repo)

    expect(result).toEqual({ source: 'local', command: 'echo "legacy setup"' })
  })

  it('uses local setup source by default when yaml exists without supported hooks', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('futureFeature: enabled\n')

    const { getSetupCommandSource } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: 'echo "legacy setup"', archive: '' }
    })
    const result = getSetupCommandSource(repo)

    expect(result).toEqual({ source: 'local', command: 'echo "legacy setup"' })
  })

  it('uses shared setup source when only archive has a legacy local script', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      'scripts:\n  setup: |\n    echo "yaml setup"\n  archive: |\n    echo "yaml archive"\n'
    )

    const { getSetupCommandSource } = await import('./hooks')
    const repo = makeRepo({
      mode: 'override',
      scripts: { setup: '', archive: 'echo "legacy archive"' }
    })
    const result = getSetupCommandSource(repo)

    expect(result).toEqual({ source: 'yaml', command: 'echo "yaml setup"' })
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

    const fs = await import('node:fs')
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

    const fs = await import('node:fs')
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
          shell: '/bin/bash',
          // Setup hooks run unattended: git in them must not pop the OS
          // credential helper's OAuth window and loop it (issue #7652).
          env: expect.objectContaining({
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never'
          })
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

    const fs = await import('node:fs')
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
        // #7652 regression: the unattended WSL hook branch must carry the
        // credential guard, and WSLENV is what carries it into the distro.
        expect.objectContaining({
          env: expect.objectContaining({
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
            WSLENV: expect.stringContaining('GIT_TERMINAL_PROMPT')
          })
        }),
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

  it('runs Windows-path hooks through WSL when the project runtime targets WSL', async () => {
    execMock.mockReset()
    execFileMock.mockReset()
    execFileMock.mockImplementation((_file, _args, options, callback) => {
      callback?.(null, '', '')
      expect(options).toEqual(
        expect.objectContaining({
          env: expect.objectContaining({
            ORCA_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
            ORCA_WORKTREE_PATH: '/mnt/c/Users/jinwo/git/orca-feature',
            CONDUCTOR_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
            GHOSTX_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca'
          })
        })
      )
      return {} as never
    })

    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { runHook } = await import('./hooks')
      const result = await runHook(
        'setup',
        'C:\\Users\\jinwo\\git\\orca-feature',
        {
          ...makeRepo(),
          path: 'C:\\Users\\jinwo\\git\\orca'
        },
        undefined,
        { wslDistro: 'Ubuntu' }
      )

      expect(result).toEqual({ success: true, output: '' })
      expect(execFileMock).toHaveBeenCalledWith(
        'wsl.exe',
        [
          '-d',
          'Ubuntu',
          '--',
          'bash',
          '-c',
          "cd '/mnt/c/Users/jinwo/git/orca-feature' && echo hello"
        ],
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

  it('writes Windows-path setup runners through WSL git when the project runtime targets WSL', async () => {
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('/mnt/c/Users/jinwo/git/orca/.git/orca/setup-runner.sh\n')

    const fs = await import('node:fs')
    const mkdirSyncMock = vi.mocked(fs.mkdirSync)
    const writeFileSyncMock = vi.mocked(fs.writeFileSync)
    const chmodSyncMock = vi.mocked(fs.chmodSync)

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { createSetupRunnerScript } = await import('./hooks')
      const result = createSetupRunnerScript(
        {
          ...makeRepo(),
          path: 'C:\\Users\\jinwo\\git\\orca'
        },
        'C:\\Users\\jinwo\\git\\orca-feature',
        'echo hello',
        { wslDistro: 'Ubuntu' }
      )

      expect(gitExecFileSyncMock).toHaveBeenCalledWith(
        ['rev-parse', '--git-path', 'orca/setup-runner.sh'],
        {
          cwd: 'C:\\Users\\jinwo\\git\\orca-feature',
          wslDistro: 'Ubuntu'
        }
      )
      expect(result.runnerScriptPath).toContain('setup-runner.sh')
      expect(mkdirSyncMock).toHaveBeenCalled()
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        expect.stringContaining('setup-runner.sh'),
        '#!/usr/bin/env bash\nset -e\necho hello\n',
        'utf-8'
      )
      expect(chmodSyncMock).toHaveBeenCalledWith(expect.stringContaining('setup-runner.sh'), 0o755)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('settles WSL hooks when wsl.exe never reports completion', async () => {
    vi.useFakeTimers()
    execMock.mockReset()
    execFileMock.mockReset()
    const killMock = vi.fn()
    execFileMock.mockImplementation(() => ({ kill: killMock }) as never)

    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { runHook } = await import('./hooks')
      const promise = runHook('setup', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\feature', {
        ...makeRepo(),
        path: 'C:\\Users\\jinwo\\git\\orca'
      })
      let settled = false
      void promise.finally(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(120_000)
      await Promise.resolve()

      expect(settled).toBe(true)
      await expect(promise).resolves.toMatchObject({
        success: false,
        output: expect.stringContaining('Hook timed out')
      })
      expect(killMock).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })
})

describe('createSetupRunnerScript', () => {
  const makeRepo = (setupAgentStartupPolicy?: 'start-immediately' | 'wait-for-setup') =>
    ({
      id: 'test-id',
      path: '/test/repo',
      displayName: 'Test Repo',
      badgeColor: '#000',
      addedAt: Date.now(),
      hookSettings: {
        mode: 'auto',
        setupAgentStartupPolicy,
        scripts: { setup: '', archive: '' }
      }
    }) as unknown as Repo

  it('omits waitForAgentStartup unless the repo explicitly waits for setup', async () => {
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('/test/repo/.git/orca/setup-runner.sh\n')
    const { createSetupRunnerScript } = await import('./hooks')

    expect(
      createSetupRunnerScript(makeRepo(), '/test/worktree', 'echo setup').waitForAgentStartup
    ).toBeUndefined()
    expect(
      createSetupRunnerScript(makeRepo('start-immediately'), '/test/worktree', 'echo setup')
        .waitForAgentStartup
    ).toBeUndefined()
    expect(
      createSetupRunnerScript(makeRepo('wait-for-setup'), '/test/worktree', 'echo setup')
        .waitForAgentStartup
    ).toBe(true)
  })

  it('marks setup-runner terminals for the always-on credential guard', async () => {
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('/test/repo/.git/orca/setup-runner.sh\n')
    const { createSetupRunnerScript } = await import('./hooks')

    const setup = createSetupRunnerScript(makeRepo(), '/test/worktree', 'git fetch')

    expect(setup.envVars).toMatchObject({
      ORCA_ROOT_PATH: '/test/repo',
      ORCA_WORKTREE_PATH: '/test/worktree',
      ORCA_INTERNAL_TERMINAL_GIT_CREDENTIAL_GUARD_POLICY: 'guard'
    })
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

describe('getDefaultTabsLaunch', () => {
  const makeRepo = (
    setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default',
    commandSourcePolicy?: 'local-only' | 'run-both' | 'shared-only'
  ) =>
    ({
      id: 'test-id',
      path: '/test/repo',
      displayName: 'Test Repo',
      badgeColor: '#000',
      addedAt: Date.now(),
      hookSettings: {
        mode: 'auto',
        setupRunPolicy,
        commandSourcePolicy,
        scripts: { setup: '', archive: '' }
      }
    }) as unknown as Repo

  it('opts into default tab command execution through the setup decision', () => {
    const hooks = {
      scripts: {},
      defaultTabs: [{ title: 'Server', command: 'pnpm dev' }]
    }

    expect(getDefaultTabsLaunch(hooks, makeRepo('skip-by-default'), 'run')).toEqual({
      tabs: hooks.defaultTabs,
      runCommands: true
    })
    expect(getDefaultTabsLaunch(hooks, makeRepo('run-by-default'), 'skip')).toEqual({
      tabs: hooks.defaultTabs,
      runCommands: false
    })
  })

  it('creates commandless default tabs without requiring setup approval', () => {
    const hooks = {
      scripts: {},
      defaultTabs: [{ title: 'Notes' }]
    }

    expect(getDefaultTabsLaunch(hooks, makeRepo('ask'))).toEqual({
      tabs: hooks.defaultTabs,
      runCommands: false
    })
  })

  it('does not run shared default tab commands when command source is local-only', () => {
    const hooks = {
      scripts: {},
      defaultTabs: [{ title: 'Server', command: 'pnpm dev' }]
    }

    expect(getDefaultTabsLaunch(hooks, makeRepo('run-by-default', 'local-only'))).toEqual({
      tabs: hooks.defaultTabs,
      runCommands: false
    })
  })
})
