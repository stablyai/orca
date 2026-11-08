import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { runCodexAppServerSession } from '../../codex/app-server/codex-app-server-session'

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

const { markCodexProjectTrusted, markCopilotFolderTrusted } = await import('./agent-trust-presets')
const { runExclusivelyForCodexTrustConfig } =
  await import('../../codex/trust/toml/codex-trust-config-mutation-queue')
const { getLocalCodexTrustConfigFiles } =
  await import('../../codex/configuration/homes/codex-home-paths')

// Real-binary tests prove Codex consumes the key; CI requires the binary instead of skipping.
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

describe('markCopilotFolderTrusted', () => {
  it('keeps a token-bearing config.json owner-only', () => {
    if (process.platform === 'win32') {
      return
    }
    const workspace = mkdtempSync(join(tmpdir(), 'orca-copilot-ws-'))
    const configPath = join(testState.fakeHomeDir, '.copilot', 'config.json')
    // A restrictive runner umask could hide a missing creation mode.
    const originalUmask = process.umask(0o022)
    try {
      mkdirSync(join(testState.fakeHomeDir, '.copilot'), { recursive: true })
      writeFileSync(configPath, JSON.stringify({ copilotTokens: { a: 'secret' } }), {
        mode: 0o600
      })
      markCopilotFolderTrusted(workspace, testState.fakeHomeDir)
      expect(statSync(configPath).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(configPath, 'utf-8')).copilotTokens).toEqual({ a: 'secret' })
    } finally {
      process.umask(originalUmask)
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('markCodexProjectTrusted', () => {
  // Hook capture/restore could silently revert an unqueued trust write (#16441).
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

  // Codex checks the starting folder before the repo root, regardless of Git layout.
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

    // thread/start shares the TUI trust lookup; workspaceWrite proves trust without a prompt.
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

    it('trusts a plain folder workspace', async () => {
      const folder = join(fixtureRoot, 'folder')
      mkdirSync(folder)
      await expectWorkspaceTrusted(folder)
    })
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
