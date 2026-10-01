import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '../shared/child-process/run-process'
import { runCodexAppServerSession } from './codex/codex-app-server-session'

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

const {
  markAntigravityWorkspaceTrusted,
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted
} = await import('./agent-trust-presets')
const { runExclusivelyForCodexTrustConfig } =
  await import('./codex/codex-trust-config-mutation-queue')
const { getLocalCodexTrustConfigFiles } = await import('./codex/codex-home-paths')

// Why: fixture tests pin Orca's half; only the real binary proves Codex reads the key
// Orca writes. CI sets REQUIRED so a missing binary fails instead of skipping.
const codexTrustContract = {
  binary: process.env.ORCA_CODEX_TRUST_CONTRACT_BINARY,
  version: process.env.ORCA_CODEX_TRUST_CONTRACT_VERSION
}
if (process.env.ORCA_CODEX_TRUST_CONTRACT_REQUIRED === '1' && !codexTrustContract.binary) {
  throw new Error('ORCA_CODEX_TRUST_CONTRACT_REQUIRED=1 but no Codex binary was given')
}

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
      markCursorWorkspaceTrusted(workspace, testState.fakeHomeDir)
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
      markCursorWorkspaceTrusted(workspace, testState.fakeHomeDir)
      const projectsDir = join(testState.fakeHomeDir, '.cursor', 'projects')
      const slugDirs = readdirSync(projectsDir)
      const trustFile = join(projectsDir, slugDirs[0], '.workspace-trusted')
      const firstPayload = readFileSync(trustFile, 'utf-8')
      markCursorWorkspaceTrusted(workspace, testState.fakeHomeDir)
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
      markCopilotFolderTrusted(workspace, testState.fakeHomeDir)
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
      markCopilotFolderTrusted(workspace, testState.fakeHomeDir)
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
      markAntigravityWorkspaceTrusted(workspace, testState.fakeHomeDir)
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
      markAntigravityWorkspaceTrusted(workspace, testState.fakeHomeDir)
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
      markAntigravityWorkspaceTrusted(parent, testState.fakeHomeDir)
      markAntigravityWorkspaceTrusted(child, testState.fakeHomeDir)
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
      const marked = markCodexProjectTrusted(
        workspace,
        getLocalCodexTrustConfigFiles(testState.fakeHomeDir)
      )
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

  // Why: Codex checks the cwd's own entry before any repo root, so the workspace key
  // must satisfy it whatever the git layout.
  describe('linked worktree trust key', { timeout: 120_000 }, () => {
    let fixtureRoot = ''
    beforeAll(() => {
      if (codexTrustContract.binary) {
        const version = runProcessSync({ program: codexTrustContract.binary, args: ['--version'] })
        expect(version.stdout.trim()).toBe(`codex-cli ${codexTrustContract.version}`)
      }
    })
    beforeEach(() => {
      fixtureRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-codex-layout-')))
    })
    afterEach(() => {
      rmSync(fixtureRoot, { recursive: true, force: true })
    })

    function git(cwd: string, ...args: string[]): void {
      const result = runProcessSync({
        program: 'git',
        args: ['-c', 'user.name=Orca', '-c', 'user.email=orca@example.com', ...args],
        cwd
      })
      expect(result.code, result.stderr).toBe(0)
    }

    function initRepoWithCommit(repo: string, ...initArgs: string[]): void {
      mkdirSync(repo, { recursive: true })
      git(repo, 'init', '-q', ...initArgs)
      git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init')
    }

    async function expectWorkspaceTrusted(workspace: string): Promise<void> {
      await markCodexProjectTrusted(workspace, getLocalCodexTrustConfigFiles(testState.fakeHomeDir))
      const runtimeHome = join(testState.userDataDir, 'codex-runtime-home', 'home')
      const [system, runtime] = [
        join(testState.fakeHomeDir, '.codex', 'config.toml'),
        join(runtimeHome, 'config.toml')
      ].map((path) =>
        [...readFileSync(path, 'utf-8').matchAll(/^\[projects\."(.*)"\]$/gm)].map((m) =>
          m[1].replaceAll('\\\\', '\\')
        )
      )
      expect(system).toEqual([workspace])
      expect(runtime).toEqual([workspace])
      if (codexTrustContract.binary) {
        expect(await codexSandboxFor(workspace, runtimeHome)).toBe('workspaceWrite')
        const emptyHome = join(fixtureRoot, 'empty-codex-home')
        mkdirSync(emptyHome, { recursive: true })
        expect(await codexSandboxFor(workspace, emptyHome)).toBe('readOnly')
      }
    }

    // Why thread/start: its default sandbox and the TUI trust prompt read the same
    // project lookup, so workspaceWrite (not readOnly) means no prompt.
    async function codexSandboxFor(cwd: string, codexHome: string): Promise<unknown> {
      const binary = codexTrustContract.binary!
      return runCodexAppServerSession(
        {
          command: binary,
          args: ['-c', 'features.plugins=false', 'app-server'],
          cliPath: binary,
          env: { CODEX_HOME: codexHome, HOME: testState.fakeHomeDir },
          timeoutMs: 60_000
        },
        async (rpc) => {
          const started = await rpc.request('thread/start', { cwd })
          const sandbox = isRecord(started) ? started.sandbox : undefined
          return isRecord(sandbox) ? sandbox.type : undefined
        }
      )
    }

    it('trusts a linked worktree of a standard repository', async () => {
      const repo = join(fixtureRoot, 'repo')
      initRepoWithCommit(repo)
      git(repo, 'worktree', 'add', '-q', join(fixtureRoot, 'wt'))
      await expectWorkspaceTrusted(join(fixtureRoot, 'wt'))
    })

    it('trusts a worktree whose main checkout .git points at a sibling .bare dir', async () => {
      const source = join(fixtureRoot, 'source')
      const project = join(fixtureRoot, 'project')
      initRepoWithCommit(source)
      git(fixtureRoot, 'clone', '-q', '--bare', source, join(project, '.bare'))
      writeFileSync(join(project, '.git'), 'gitdir: ./.bare\n', 'utf-8')
      git(project, 'worktree', 'add', '-q', join(project, 'wt'))
      await expectWorkspaceTrusted(join(project, 'wt'))
    })

    it('trusts a worktree of a bare repository', async () => {
      const source = join(fixtureRoot, 'source')
      const bare = join(fixtureRoot, 'proj.git')
      initRepoWithCommit(source)
      git(fixtureRoot, 'clone', '-q', '--bare', source, bare)
      git(bare, 'worktree', 'add', '-q', join(fixtureRoot, 'wt'))
      await expectWorkspaceTrusted(join(fixtureRoot, 'wt'))
    })

    it('trusts a worktree of a --separate-git-dir repository', async () => {
      const repo = join(fixtureRoot, 'repo')
      initRepoWithCommit(repo, `--separate-git-dir=${join(fixtureRoot, 'repo.git')}`)
      git(repo, 'worktree', 'add', '-q', join(fixtureRoot, 'wt'))
      await expectWorkspaceTrusted(join(fixtureRoot, 'wt'))
    })

    it('trusts a worktree whose parent .git points at another repository', async () => {
      const source = join(fixtureRoot, 'source')
      initRepoWithCommit(source)
      git(fixtureRoot, 'clone', '-q', '--bare', source, join(fixtureRoot, 'proj.git'))
      git(fixtureRoot, 'clone', '-q', '--bare', source, join(fixtureRoot, 'other.git'))
      writeFileSync(join(fixtureRoot, '.git'), 'gitdir: ./other.git\n', 'utf-8')
      git(join(fixtureRoot, 'proj.git'), 'worktree', 'add', '-q', join(fixtureRoot, 'wt'))
      await expectWorkspaceTrusted(join(fixtureRoot, 'wt'))
    })

    it('trusts a plain folder workspace', async () => {
      const folder = join(fixtureRoot, 'folder')
      mkdirSync(folder)
      await expectWorkspaceTrusted(folder)
    })
  })

  it('writes ~/.codex/config.toml with the project marked trusted', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'orca-codex-ws-'))
    try {
      const realpath = realpathSync.native(workspace)
      await markCodexProjectTrusted(workspace, getLocalCodexTrustConfigFiles(testState.fakeHomeDir))
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

  it('preserves existing config keys and updates an existing project block', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'orca-codex-ws-'))
    const realpath = realpathSync.native(workspace)
    try {
      const codexDir = join(testState.fakeHomeDir, '.codex')
      const runtimeCodexDir = join(testState.userDataDir, 'codex-runtime-home', 'home')
      mkdirSync(codexDir, { recursive: true })
      mkdirSync(runtimeCodexDir, { recursive: true })
      writeFileSync(
        join(codexDir, 'config.toml'),
        [
          'model = "gpt-5.5"',
          '',
          `[projects."${escapeTomlBasicString(realpath)}"]`,
          'notes = "keep"',
          'trust_level = "untrusted"',
          ''
        ].join('\n'),
        'utf-8'
      )
      writeFileSync(
        join(runtimeCodexDir, 'config.toml'),
        [
          'sandbox_mode = "workspace-write"',
          '',
          `[projects."${escapeTomlBasicString(realpath)}"]`,
          'notes = "keep-runtime"',
          'trust_level = "untrusted"',
          ''
        ].join('\n'),
        'utf-8'
      )

      await markCodexProjectTrusted(workspace, getLocalCodexTrustConfigFiles(testState.fakeHomeDir))

      const written = readFileSync(join(codexDir, 'config.toml'), 'utf-8')
      const runtimeWritten = readFileSync(join(runtimeCodexDir, 'config.toml'), 'utf-8')
      expect(written).toContain('model = "gpt-5.5"')
      expect(written).toContain('notes = "keep"')
      expect(written).toContain('trust_level = "trusted"')
      expect(written).not.toContain('trust_level = "untrusted"')
      expect(runtimeWritten).toContain('sandbox_mode = "workspace-write"')
      expect(runtimeWritten).toContain('notes = "keep-runtime"')
      expect(runtimeWritten).toContain('trust_level = "trusted"')
      expect(runtimeWritten).not.toContain('trust_level = "untrusted"')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

function escapeTomlBasicString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
