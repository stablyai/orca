import { describe, expect, it, vi } from 'vitest'
import type { OrcaHooks } from '../shared/orca-yaml-hook-types'
import { getDefaultTabCommandTrustContent, getDefaultTabsLaunch } from './effective-hook-config'
import {
  makeHookTestRepo,
  TEST_REPO_ORCA_YAML_PATH,
  TEST_WORKTREE_ORCA_YAML_PATH,
  TEST_WORKTREE_PATH
} from './hooks-test-fixtures'

// Mock fs used by loadHooks
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn()
}))

describe('getEffectiveHooks', () => {
  // We need to dynamically import after mocking
  const makeRepo = (hookSettings?: {
    mode?: 'auto' | 'override'
    setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default'
    commandSourcePolicy?: 'shared-only' | 'local-only' | 'run-both'
    scripts?: { setup: string; archive: string }
  }) => makeHookTestRepo(hookSettings)

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

describe('shouldRunSetupForCreate', () => {
  const makeRepo = (setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default') =>
    makeHookTestRepo({
      mode: 'auto',
      setupRunPolicy,
      scripts: { setup: '', archive: '' }
    })

  it('requires an explicit decision when the repo policy is ask', async () => {
    const { shouldRunSetupForCreate } = await import('./effective-hook-config')

    expect(() => shouldRunSetupForCreate(makeRepo('ask'))).toThrow(
      'Setup decision required for this repository'
    )
  })

  it('uses the repo default when the caller inherits', async () => {
    const { shouldRunSetupForCreate } = await import('./effective-hook-config')

    expect(shouldRunSetupForCreate(makeRepo('run-by-default'))).toBe(true)
    expect(shouldRunSetupForCreate(makeRepo('skip-by-default'))).toBe(false)
  })

  it('lets the caller override the repo default per create', async () => {
    const { shouldRunSetupForCreate } = await import('./effective-hook-config')

    expect(shouldRunSetupForCreate(makeRepo('skip-by-default'), 'run')).toBe(true)
    expect(shouldRunSetupForCreate(makeRepo('run-by-default'), 'skip')).toBe(false)
  })
})

describe('getDefaultTabsLaunch', () => {
  const makeRepo = (
    setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default',
    commandSourcePolicy?: 'local-only' | 'run-both' | 'shared-only'
  ) =>
    makeHookTestRepo({
      mode: 'auto',
      setupRunPolicy,
      commandSourcePolicy,
      scripts: { setup: '', archive: '' }
    })

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

  it('treats env-only tabs as shared content requiring the setup decision', () => {
    const hooks = {
      scripts: {},
      defaultTabs: [{ title: 'Shell', env: { ANTHROPIC_API_KEY: 'op://Private/Anthropic/key' } }]
    } as unknown as OrcaHooks

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

describe('getDefaultTabCommandTrustContent', () => {
  it('includes tab env in the trust content so env changes re-prompt trust', () => {
    const hooks = {
      scripts: {},
      defaultTabs: [
        {
          title: 'Claude',
          command: 'claude',
          env: { ANTHROPIC_API_KEY: 'op://Private/Anthropic/api-key' }
        }
      ]
    } as unknown as OrcaHooks

    const content = getDefaultTabCommandTrustContent(hooks)
    expect(content).toContain('ANTHROPIC_API_KEY=op://Private/Anthropic/api-key')
    expect(content).toContain('claude')
  })

  it('covers env-only tabs that have no command', () => {
    const hooks = {
      scripts: {},
      defaultTabs: [{ title: 'Shell', env: { LD_PRELOAD: '/evil.so' } }]
    } as unknown as OrcaHooks

    expect(getDefaultTabCommandTrustContent(hooks)).toContain('LD_PRELOAD=/evil.so')
  })
})

describe('trust content is shared with the renderer (Codex review)', () => {
  it('changes when only committed env changes, so an added NODE_OPTIONS re-prompts trust', () => {
    const before = {
      scripts: {},
      defaultTabs: [{ title: 'Claude', command: 'claude' }]
    } as unknown as OrcaHooks
    const after = {
      scripts: {},
      defaultTabs: [
        { title: 'Claude', command: 'claude', env: { NODE_OPTIONS: '--require ./payload.js' } }
      ]
    } as unknown as OrcaHooks

    expect(getDefaultTabCommandTrustContent(after)).not.toBe(
      getDefaultTabCommandTrustContent(before)
    )
    expect(getDefaultTabCommandTrustContent(after)).toContain('NODE_OPTIONS=--require ./payload.js')
  })

  it('produces non-empty content for env-only tabs so they cannot auto-accept', () => {
    const hooks = {
      scripts: {},
      defaultTabs: [{ title: 'Shell', env: { PATH: '/tmp/evil:/usr/bin' } }]
    } as unknown as OrcaHooks

    expect(getDefaultTabCommandTrustContent(hooks)).not.toBe('')
  })
})

describe('trust content is unambiguous (Codex/CodeRabbit review)', () => {
  it('does not collide a multi-key env with a single value that embeds a newline', () => {
    // The embedded-newline variant cannot reach here (orca-yaml rejects it); assert the
    // serialization would distinguish them anyway, so the two layers cannot both regress silently.
    const twoKeys = {
      scripts: {},
      defaultTabs: [{ title: 'T', env: { FOO: 'safe', PATH: 'evil' } }]
    } as unknown as OrcaHooks
    const oneKey = {
      scripts: {},
      defaultTabs: [{ title: 'T', env: { FOO: 'safe' } }]
    } as unknown as OrcaHooks

    expect(getDefaultTabCommandTrustContent(twoKeys)).not.toBe(
      getDefaultTabCommandTrustContent(oneKey)
    )
  })

  it('is stable under env key re-ordering, which changes nothing semantically', () => {
    const a = {
      scripts: {},
      defaultTabs: [{ title: 'T', env: { B: '2', A: '1' } }]
    } as unknown as OrcaHooks
    const b = {
      scripts: {},
      defaultTabs: [{ title: 'T', env: { A: '1', B: '2' } }]
    } as unknown as OrcaHooks

    expect(getDefaultTabCommandTrustContent(a)).toBe(getDefaultTabCommandTrustContent(b))
  })
})

describe('trust content cannot be forged by free text (Codex re-review)', () => {
  const trust = (hooks: unknown) => getDefaultTabCommandTrustContent(hooks as OrcaHooks)

  it('does not let a command whose first line is an assignment collide with a real env entry', () => {
    // Only the env form actually exports the variable into the spawned PTY, so these
    // must never share a hash — an approved hash would otherwise activate NODE_OPTIONS.
    const commandOnly = {
      scripts: {},
      defaultTabs: [{ title: 'T', command: 'NODE_OPTIONS=--require ./payload.js\nnode app.js' }]
    }
    const realEnv = {
      scripts: {},
      defaultTabs: [
        { title: 'T', env: { NODE_OPTIONS: '--require ./payload.js' }, command: 'node app.js' }
      ]
    }

    expect(trust(commandOnly)).not.toBe(trust(realEnv))
  })

  it('does not let a command forge an additional defaultTabs block', () => {
    const oneTab = {
      scripts: {},
      defaultTabs: [{ title: 'A', command: 'x\n\n# defaultTabs[2] B\ny' }]
    }
    const twoTabs = {
      scripts: {},
      defaultTabs: [
        { title: 'A', command: 'x' },
        { title: 'B', command: 'y' }
      ]
    }

    expect(trust(oneTab)).not.toBe(trust(twoTabs))
  })

  it('does not let a setup script forge a defaultTabs block', () => {
    const setupOnly = { scripts: { setup: '# defaultTabs[1] T\n  env FOO=evil' } }
    const realTab = { scripts: {}, defaultTabs: [{ title: 'T', env: { FOO: 'evil' } }] }

    expect(trust(setupOnly)).not.toBe(trust(realTab))
  })
})

describe('trust content survives hooks parsed by another build (Codex final gate)', () => {
  const trust = (hooks: unknown) => getDefaultTabCommandTrustContent(hooks as OrcaHooks)

  it('does not let a newline-bearing title forge a second defaultTabs block', () => {
    // Why: this shape cannot come from THIS parser, but a remote host on an older
    // build parses it happily and the client trusts already-parsed hooks without
    // revalidating — so the serializer, not the parser, has to hold the line.
    const forged = {
      scripts: {},
      defaultTabs: [{ title: 'A\n    x\n\n# defaultTabs[2] B', command: 'y' }]
    }
    const real = {
      scripts: {},
      defaultTabs: [
        { title: 'A', command: 'x' },
        { title: 'B', command: 'y' }
      ]
    }

    expect(trust(forged)).not.toBe(trust(real))
  })

  it('escapes titles so a quote or backslash cannot shift the header', () => {
    const a = { scripts: {}, defaultTabs: [{ title: 'A" B', command: 'x' }] }
    const b = { scripts: {}, defaultTabs: [{ title: 'A\\" B', command: 'x' }] }

    expect(trust(a)).not.toBe(trust(b))
  })
})
