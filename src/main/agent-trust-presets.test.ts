import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AtomicWrite from './codex/config-toml-atomic-write'

const testState = {
  fakeHomeDir: '',
  userDataDir: '',
  previousUserDataPath: undefined as string | undefined
}

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return testState.userDataDir
      }
      throw new Error(`unexpected app.getPath(${name})`)
    }
  }
}))

vi.mock('node:os', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

vi.mock('./codex/config-toml-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof AtomicWrite>()
  return { ...actual, writeTomlConfigAtomically: vi.fn(actual.writeTomlConfigAtomically) }
})

const {
  markAntigravityWorkspaceTrusted,
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted
} = await import('./agent-trust-presets')
const { runExclusivelyForCodexTrustConfig } =
  await import('./codex/codex-trust-config-mutation-queue')
const { writeTomlConfigAtomically } = await import('./codex/config-toml-atomic-write')

beforeEach(() => {
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-trust-presets-'))
  testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-trust-presets-user-data-'))
  testState.previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = testState.userDataDir
})

afterEach(() => {
  rmSync(testState.fakeHomeDir, { recursive: true, force: true })
  rmSync(testState.userDataDir, { recursive: true, force: true })
  if (testState.previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = testState.previousUserDataPath
  }
  testState.fakeHomeDir = ''
  testState.userDataDir = ''
  testState.previousUserDataPath = undefined
})

describe('markCursorWorkspaceTrusted', () => {
  it('writes ~/.cursor/projects/<slug>/.workspace-trusted with the cwd payload', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'orca-cursor-ws-'))
    try {
      markCursorWorkspaceTrusted(workspace)
      const projectsDir = join(testState.fakeHomeDir, '.cursor', 'projects')
      const slugDirs = readdirSync(projectsDir)
      expect(slugDirs.length).toBe(1)
      const trustFile = join(projectsDir, slugDirs[0], '.workspace-trusted')
      expect(existsSync(trustFile)).toBe(true)
      const payload = JSON.parse(readFileSync(trustFile, 'utf-8'))
      expect(payload.workspacePath).toBeTruthy()
      expect(typeof payload.trustedAt).toBe('string')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('is idempotent — re-marking the same workspace does not overwrite trustedAt', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'orca-cursor-ws-'))
    try {
      markCursorWorkspaceTrusted(workspace)
      const projectsDir = join(testState.fakeHomeDir, '.cursor', 'projects')
      const slugDirs = readdirSync(projectsDir)
      const trustFile = join(projectsDir, slugDirs[0], '.workspace-trusted')
      const firstPayload = readFileSync(trustFile, 'utf-8')
      markCursorWorkspaceTrusted(workspace)
      const secondPayload = readFileSync(trustFile, 'utf-8')
      expect(secondPayload).toBe(firstPayload)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('markCopilotFolderTrusted', () => {
  it('appends the workspace to trustedFolders in ~/.copilot/config.json', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'orca-copilot-ws-'))
    try {
      markCopilotFolderTrusted(workspace)
      const configPath = join(testState.fakeHomeDir, '.copilot', 'config.json')
      expect(existsSync(configPath)).toBe(true)
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(Array.isArray(parsed.trustedFolders)).toBe(true)
      expect(parsed.trustedFolders.length).toBe(1)
      expect(typeof parsed.trustedFolders[0]).toBe('string')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('preserves existing config keys and dedups already-trusted folders', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'orca-copilot-ws-'))
    const realpath = realpathSync(workspace)
    try {
      mkdirSync(join(testState.fakeHomeDir, '.copilot'), { recursive: true })
      writeFileSync(
        join(testState.fakeHomeDir, '.copilot', 'config.json'),
        JSON.stringify({
          firstLaunchAt: '2026-01-01T00:00:00.000Z',
          trustedFolders: [realpath]
        })
      )
      markCopilotFolderTrusted(workspace)
      const parsed = JSON.parse(
        readFileSync(join(testState.fakeHomeDir, '.copilot', 'config.json'), 'utf-8')
      )
      expect(parsed.firstLaunchAt).toBe('2026-01-01T00:00:00.000Z')
      expect(parsed.trustedFolders).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('markAntigravityWorkspaceTrusted', () => {
  it('appends the workspace to trustedWorkspaces in ~/.gemini/antigravity-cli/settings.json', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'orca-agy-ws-'))
    try {
      markAntigravityWorkspaceTrusted(workspace)
      const configPath = join(testState.fakeHomeDir, '.gemini', 'antigravity-cli', 'settings.json')
      expect(existsSync(configPath)).toBe(true)
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(Array.isArray(parsed.trustedWorkspaces)).toBe(true)
      expect(parsed.trustedWorkspaces).toHaveLength(1)
      expect(parsed.trustedWorkspaces[0]).toBe(realpathSync(workspace))
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  // Why: the same settings.json also carries model, permissions and toolPermission. A
  // clobbering write here would silently reset the user's agy configuration.
  it('preserves sibling settings keys and dedups an already-trusted workspace', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'orca-agy-ws-'))
    const realpath = realpathSync(workspace)
    try {
      mkdirSync(join(testState.fakeHomeDir, '.gemini', 'antigravity-cli'), { recursive: true })
      writeFileSync(
        join(testState.fakeHomeDir, '.gemini', 'antigravity-cli', 'settings.json'),
        JSON.stringify({
          agentMode: 'accept-edits',
          model: 'gemini-3.8-flash',
          trustedWorkspaces: [realpath]
        })
      )
      markAntigravityWorkspaceTrusted(workspace)
      const parsed = JSON.parse(
        readFileSync(
          join(testState.fakeHomeDir, '.gemini', 'antigravity-cli', 'settings.json'),
          'utf-8'
        )
      )
      expect(parsed.agentMode).toBe('accept-edits')
      expect(parsed.model).toBe('gemini-3.8-flash')
      expect(parsed.trustedWorkspaces).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  // Why: agy's trust is exact-path, not inherited — a parent entry does not cover a child,
  // which is what makes the per-worktree preflight necessary at all.
  it('adds a child worktree even when its parent is already trusted', () => {
    const parent = mkdtempSync(join(tmpdir(), 'orca-agy-parent-'))
    const child = join(parent, 'child-worktree')
    try {
      mkdirSync(child, { recursive: true })
      markAntigravityWorkspaceTrusted(parent)
      markAntigravityWorkspaceTrusted(child)
      const parsed = JSON.parse(
        readFileSync(
          join(testState.fakeHomeDir, '.gemini', 'antigravity-cli', 'settings.json'),
          'utf-8'
        )
      )
      expect(parsed.trustedWorkspaces).toHaveLength(2)
      expect(parsed.trustedWorkspaces).toContain(realpathSync(child))
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe('markCodexProjectTrusted', () => {
  // Why (#16441): a hook install/grant holds this file across an awaited
  // app-server session; an unqueued write here lands inside its
  // capture->restore window and is silently reverted.
  it('queues behind an in-flight Codex trust-config mutation', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'orca-codex-ws-'))
    const configPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    let releaseGrant!: () => void
    const grantHoldingTheFile = new Promise<void>((resolve) => {
      releaseGrant = resolve
    })
    try {
      const held = runExclusivelyForCodexTrustConfig(configPath, () => grantHoldingTheFile)
      const marked = markCodexProjectTrusted(workspace)
      await Promise.resolve()
      expect(existsSync(configPath)).toBe(false)

      releaseGrant()
      await held
      await marked
      expect(readFileSync(configPath, 'utf-8')).toContain('trust_level = "trusted"')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('trusts the main repository root for a linked worktree without reading commondir', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'orca-codex-linked-ws-'))
    const repository = join(fixtureRoot, 'repo')
    const workspace = join(fixtureRoot, 'worktrees', 'feature')
    const worktreeGitDir = join(repository, '.git', 'worktrees', 'feature')
    try {
      mkdirSync(worktreeGitDir, { recursive: true })
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf-8')
      writeFileSync(join(worktreeGitDir, 'gitdir'), join(workspace, '.git'), 'utf-8')

      await markCodexProjectTrusted(workspace)

      const repositoryRoot = realpathSync.native(repository)
      const workspaceRoot = realpathSync.native(workspace)
      const configPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
      const runtimeConfigPath = join(
        testState.userDataDir,
        'codex-runtime-home',
        'home',
        'config.toml'
      )
      for (const written of [
        readFileSync(configPath, 'utf-8'),
        readFileSync(runtimeConfigPath, 'utf-8')
      ]) {
        expect(written).toContain(`[projects."${escapeTomlBasicString(repositoryRoot)}"]`)
        expect(written).not.toContain(`[projects."${escapeTomlBasicString(workspaceRoot)}"]`)
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('does not broaden trust through arbitrary or adversarial Git metadata', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'orca-codex-untrusted-gitdir-'))
    const workspace = join(fixtureRoot, 'workspace')
    const arbitraryGitDir = join(fixtureRoot, 'metadata', 'feature')
    const unrelatedRoot = join(fixtureRoot, 'unrelated')
    try {
      mkdirSync(arbitraryGitDir, { recursive: true })
      mkdirSync(workspace, { recursive: true })
      mkdirSync(unrelatedRoot, { recursive: true })
      writeFileSync(join(workspace, '.git'), `gitdir: ${arbitraryGitDir}\n`, 'utf-8')
      writeFileSync(join(arbitraryGitDir, 'commondir'), join(unrelatedRoot, '.git'), 'utf-8')

      await markCodexProjectTrusted(workspace)
      const structuredGitDir = join(unrelatedRoot, '.git', 'worktrees', 'feature')
      mkdirSync(structuredGitDir, { recursive: true })
      writeFileSync(join(workspace, '.git'), `gitdir: ${structuredGitDir}\n`, 'utf-8')
      writeFileSync(join(structuredGitDir, 'gitdir'), join(unrelatedRoot, '.git'), 'utf-8')
      await markCodexProjectTrusted(workspace)

      const written = readFileSync(join(testState.fakeHomeDir, '.codex', 'config.toml'), 'utf-8')
      expect(written).toContain(
        `[projects."${escapeTomlBasicString(realpathSync.native(workspace))}"]`
      )
      expect(written).not.toContain(
        `[projects."${escapeTomlBasicString(realpathSync.native(unrelatedRoot))}"]`
      )
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('writes ~/.codex/config.toml with the project marked trusted', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'orca-codex-ws-'))
    try {
      const realpath = realpathSync.native(workspace)
      await markCodexProjectTrusted(workspace)
      const configPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
      const runtimeConfigPath = join(
        testState.userDataDir,
        'codex-runtime-home',
        'home',
        'config.toml'
      )
      expect(existsSync(configPath)).toBe(true)
      expect(existsSync(runtimeConfigPath)).toBe(true)
      const written = readFileSync(configPath, 'utf-8')
      const runtimeWritten = readFileSync(runtimeConfigPath, 'utf-8')
      expect(written).toContain(`[projects."${escapeTomlBasicString(realpath)}"]`)
      expect(written).toContain('trust_level = "trusted"')
      expect(runtimeWritten).toContain(`[projects."${escapeTomlBasicString(realpath)}"]`)
      expect(runtimeWritten).toContain('trust_level = "trusted"')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('markCodexProjectTrusted keeps the answer the user already gave', () => {
  const systemConfigPath = (): string => join(testState.fakeHomeDir, '.codex', 'config.toml')
  const runtimeConfigPath = (): string =>
    join(testState.userDataDir, 'codex-runtime-home', 'home', 'config.toml')
  const projectHeader = (path: string): string =>
    `[projects."${escapeTomlBasicString(realpathSync.native(path))}"]`

  function seedSystemConfig(content: string): void {
    mkdirSync(join(testState.fakeHomeDir, '.codex'), { recursive: true })
    writeFileSync(systemConfigPath(), content, 'utf-8')
  }

  function backdate(path: string): number {
    const past = new Date(Date.now() - 60_000)
    utimesSync(path, past, past)
    return statSync(path).mtimeMs
  }

  let workspace = ''
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'orca-codex-ws-'))
    vi.mocked(writeTomlConfigAtomically).mockClear()
  })
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('keeps an explicit untrusted answer, and never trusts the project in the runtime home', async () => {
    const original = [
      'model = "gpt-5.5"',
      '',
      projectHeader(workspace),
      'notes = "keep"',
      'trust_level = "untrusted"',
      ''
    ].join('\n')
    seedSystemConfig(original)

    await markCodexProjectTrusted(workspace)

    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(original)
    expect(existsSync(runtimeConfigPath())).toBe(false)
  })

  it.each(['trust_level = "Trusted"', 'trust_level = "maybe"', 'trust_level = trusted'])(
    'leaves a value Codex cannot read as trusted or untrusted alone: %s',
    async (trustLine) => {
      const original = [projectHeader(workspace), trustLine, ''].join('\n')
      seedSystemConfig(original)

      await markCodexProjectTrusted(workspace)

      expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(original)
      expect(existsSync(runtimeConfigPath())).toBe(false)
    }
  )

  it('adds trusted once, leaving the rest of config.toml byte-identical', async () => {
    const original = [
      '# my settings',
      "model = 'gpt-5.5'  # keep this spacing",
      '',
      '[projects."/somewhere/else"]',
      'trust_level = "untrusted"',
      ''
    ].join('\n')
    seedSystemConfig(original)

    await markCodexProjectTrusted(workspace)

    const trustBlock = `${projectHeader(workspace)}\ntrust_level = "trusted"\n`
    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(`${original}\n${trustBlock}`)
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toBe(trustBlock)

    const systemMtime = backdate(systemConfigPath())
    const runtimeMtime = backdate(runtimeConfigPath())

    await markCodexProjectTrusted(workspace)

    expect(statSync(systemConfigPath()).mtimeMs).toBe(systemMtime)
    expect(statSync(runtimeConfigPath()).mtimeMs).toBe(runtimeMtime)
  })

  it('keeps an explicit untrusted answer on the repository root a linked worktree resolves to', async () => {
    const repository = join(workspace, 'repo')
    const worktree = join(workspace, 'worktrees', 'feature')
    const worktreeGitDir = join(repository, '.git', 'worktrees', 'feature')
    mkdirSync(worktreeGitDir, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf-8')
    writeFileSync(join(worktreeGitDir, 'gitdir'), join(worktree, '.git'), 'utf-8')
    const original = [projectHeader(repository), 'trust_level = "untrusted"', ''].join('\n')
    seedSystemConfig(original)

    await markCodexProjectTrusted(worktree)

    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(original)
    expect(existsSync(runtimeConfigPath())).toBe(false)
  })

  // Why: Codex reads the cwd first, so a cwd entry Orca adds would outrank the root's answer.
  it('keeps an untrusted repository root for a folder workspace opened on a subdirectory', async () => {
    const repository = join(workspace, 'repo')
    const subdirectory = join(repository, 'packages', 'app')
    mkdirSync(join(repository, '.git'), { recursive: true })
    writeFileSync(join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8')
    mkdirSync(subdirectory, { recursive: true })
    const original = [projectHeader(repository), 'trust_level = "untrusted"', ''].join('\n')
    seedSystemConfig(original)

    await markCodexProjectTrusted(subdirectory)

    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(original)
    expect(existsSync(runtimeConfigPath())).toBe(false)
  })

  it('follows the subdirectory’s own answer over its repository root’s, as Codex does', async () => {
    const repository = join(workspace, 'repo')
    const subdirectory = join(repository, 'packages', 'app')
    mkdirSync(join(repository, '.git'), { recursive: true })
    writeFileSync(join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8')
    mkdirSync(subdirectory, { recursive: true })
    const original = [
      projectHeader(repository),
      'trust_level = "untrusted"',
      '',
      projectHeader(subdirectory),
      'trust_level = "trusted"',
      ''
    ].join('\n')
    seedSystemConfig(original)

    await markCodexProjectTrusted(subdirectory)

    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(original)
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toBe(
      `${projectHeader(subdirectory)}\ntrust_level = "trusted"\n`
    )
  })

  it('keeps an explicit untrusted answer on a linked worktree’s own path', async () => {
    const repository = join(workspace, 'repo')
    const worktree = join(workspace, 'worktrees', 'feature')
    const worktreeGitDir = join(repository, '.git', 'worktrees', 'feature')
    mkdirSync(worktreeGitDir, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf-8')
    writeFileSync(join(worktreeGitDir, 'gitdir'), join(worktree, '.git'), 'utf-8')
    const original = [projectHeader(worktree), 'trust_level = "untrusted"', ''].join('\n')
    seedSystemConfig(original)

    await markCodexProjectTrusted(worktree)

    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(original)
    expect(existsSync(runtimeConfigPath())).toBe(false)
  })

  // Why: Codex reads the checkout holding the `.git` file before the main repository; for a submodule that checkout is where its own prompt records the answer.
  it.each([
    ['a linked worktree', 'worktrees'],
    ['a submodule', 'modules']
  ])(
    'keeps an untrusted answer on %s checkout for a folder workspace opened on its subdirectory',
    async (_label, metadataDir) => {
      const repository = join(workspace, 'repo')
      const checkout = join(workspace, 'checkout')
      const subdirectory = join(checkout, 'packages', 'app')
      const checkoutGitDir = join(repository, '.git', metadataDir, 'checkout')
      mkdirSync(checkoutGitDir, { recursive: true })
      mkdirSync(subdirectory, { recursive: true })
      writeFileSync(join(checkout, '.git'), `gitdir: ${checkoutGitDir}\n`, 'utf-8')
      writeFileSync(join(checkoutGitDir, 'gitdir'), join(checkout, '.git'), 'utf-8')
      const original = [projectHeader(checkout), 'trust_level = "untrusted"', ''].join('\n')
      seedSystemConfig(original)

      await markCodexProjectTrusted(subdirectory)

      expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(original)
      expect(existsSync(runtimeConfigPath())).toBe(false)
    }
  )

  // Why: Codex passes over a `.git` directory with no HEAD, so the checkout it reads is the one above.
  it('keeps an untrusted repository root above a nested `.git` directory with no HEAD', async () => {
    const repository = join(workspace, 'repo')
    const nested = join(repository, 'vendor', 'lib')
    const subdirectory = join(nested, 'src')
    mkdirSync(join(repository, '.git'), { recursive: true })
    writeFileSync(join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8')
    mkdirSync(join(nested, '.git'), { recursive: true })
    mkdirSync(subdirectory, { recursive: true })
    const original = [projectHeader(repository), 'trust_level = "untrusted"', ''].join('\n')
    seedSystemConfig(original)

    await markCodexProjectTrusted(subdirectory)

    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(original)
    expect(existsSync(runtimeConfigPath())).toBe(false)
  })

  it('trusts only the subdirectory when its repository has no answer', async () => {
    const repository = join(workspace, 'repo')
    const subdirectory = join(repository, 'packages', 'app')
    mkdirSync(join(repository, '.git'), { recursive: true })
    writeFileSync(join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf-8')
    mkdirSync(subdirectory, { recursive: true })

    await markCodexProjectTrusted(subdirectory)

    const written = readFileSync(systemConfigPath(), 'utf-8')
    expect(written).toBe(`${projectHeader(subdirectory)}\ntrust_level = "trusted"\n`)
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toBe(written)
  })

  it('keeps an explicit untrusted answer on a folder workspace', async () => {
    const folder = join(workspace, 'notes')
    mkdirSync(folder)
    const original = [projectHeader(folder), 'trust_level = "untrusted"', ''].join('\n')
    seedSystemConfig(original)

    await markCodexProjectTrusted(folder)

    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(original)
    expect(existsSync(runtimeConfigPath())).toBe(false)
  })

  it('still trusts an unanswered project in the runtime home when the ~/.codex write fails', async () => {
    const original = 'model = "gpt-5.5"\n'
    seedSystemConfig(original)
    vi.mocked(writeTomlConfigAtomically).mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await markCodexProjectTrusted(workspace)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }

    expect(readFileSync(systemConfigPath(), 'utf-8')).toBe(original)
    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toBe(
      `${projectHeader(workspace)}\ntrust_level = "trusted"\n`
    )
  })

  it('keeps an untrusted answer the runtime home already holds', async () => {
    const runtimeOriginal = [projectHeader(workspace), 'trust_level = "untrusted"', ''].join('\n')
    mkdirSync(dirname(runtimeConfigPath()), { recursive: true })
    writeFileSync(runtimeConfigPath(), runtimeOriginal, 'utf-8')

    await markCodexProjectTrusted(workspace)

    expect(readFileSync(runtimeConfigPath(), 'utf-8')).toBe(runtimeOriginal)
  })
})

function escapeTomlBasicString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}
