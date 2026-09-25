import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState: { fakeHomeDir: string; userDataDir: string; previousUserDataPath?: string } = {
  fakeHomeDir: '',
  userDataDir: ''
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

const {
  configureAgentConfigIsolation,
  isExternalAgentConfigIsolated,
  didIsolationTurnOff,
  onBeforeAgentConfigIsolation,
  releaseExternalAgentStateBeforeIsolation,
  isIsolationTurningOn,
  resetAgentConfigIsolationForTests
} = await import('./agent-config-isolation')
const {
  markAntigravityWorkspaceTrusted,
  markCodexProjectTrusted,
  markCopilotFolderTrusted,
  markCursorWorkspaceTrusted
} = await import('./agent-trust-presets')
const { promoteCodexRuntimeHookApprovalsToSystem } = await import('./codex/hook-trust-promotion')
const { ensureRealHomeCodexHookState } = await import('./codex/codex-real-home-hook-install')
const { syncSystemConfigIntoManagedCodexHome } = await import('./codex/codex-config-mirror')
const { installRemoteManagedAgentHooks } =
  await import('./agent-hooks/remote-managed-hook-installers')
const { ClaudeRuntimeAuthService } = await import('./claude-accounts/runtime-auth-service')
const { applyAgentStatusHooksEnabled, installManagedAgentHooks, isAgentStatusHooksEnabled } =
  await import('./agent-hooks/managed-agent-hook-controls')

const SEEDED_FILES: Record<string, string> = {
  '.claude/settings.json': '{\n  "hooks": {}\n}\n',
  '.claude/.credentials.json': '{"claudeAiOauth":{}}\n',
  '.codex/config.toml': 'model = "gpt-5"\n',
  '.codex/hooks.json': '{\n  "hooks": {}\n}\n',
  '.codex/auth.json': '{}\n',
  '.copilot/config.json': '{}\n',
  '.gemini/antigravity-cli/settings.json': '{}\n'
}

function seedHome(home: string): void {
  for (const [path, contents] of Object.entries(SEEDED_FILES)) {
    const target = join(home, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, contents)
  }
}

function snapshotTree(root: string, skip: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (full === skip) {
        continue
      }
      if (statSync(full).isDirectory()) {
        files.set(`${relative(root, full)}/`, '')
        walk(full)
      } else {
        files.set(relative(root, full), readFileSync(full, 'utf-8'))
      }
    }
  }
  walk(root)
  return files
}

async function runEveryGatedWriter(workspacePath: string): Promise<void> {
  markCursorWorkspaceTrusted(workspacePath)
  markCopilotFolderTrusted(workspacePath)
  markAntigravityWorkspaceTrusted(workspacePath)
  await markCodexProjectTrusted(workspacePath)
  promoteCodexRuntimeHookApprovalsToSystem()
  syncSystemConfigIntoManagedCodexHome()
  await ensureRealHomeCodexHookState({ hooksEnabled: true, userDataPath: testState.userDataDir })
  await installManagedAgentHooks({ isolateExternalAgentConfig: true })
  await applyAgentStatusHooksEnabled(true, { isolateExternalAgentConfig: true })
  // Why an empty sftp: any remote write attempt would throw on the missing methods.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the isolation gate returns before sftp is touched.
  const remote = await installRemoteManagedAgentHooks({} as never, '/home/remote', {
    agents: ['claude', 'codex']
  })
  expect(remote).toEqual([])
}

async function countManagedAccountReadsDuringSync(isolated: boolean): Promise<number> {
  configureAgentConfigIsolation(() => ({ isolateExternalAgentConfig: isolated }))
  let reads = 0
  const settings = {
    get claudeManagedAccounts() {
      reads += 1
      return []
    },
    activeClaudeManagedAccountId: null
  }
  const store = { getSettings: () => settings, updateSettings: vi.fn(() => settings) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sync only reads settings through this store.
  const claudeAuth = new ClaudeRuntimeAuthService(store as never)
  await claudeAuth.syncForCurrentSelection()
  reads = 0
  await claudeAuth.syncForCurrentSelection({ runtime: 'host', wslDistro: null })
  return reads
}

describe('external agent config isolation', () => {
  let workspacePath = ''

  beforeEach(() => {
    // Why userData inside HOME: mirrors Linux (~/.config/Orca) so the snapshot proves
    // writes stay confined to userData rather than merely landing in another temp dir.
    testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-isolation-home-'))
    testState.userDataDir = join(testState.fakeHomeDir, '.config', 'Orca')
    mkdirSync(testState.userDataDir, { recursive: true })
    testState.previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = testState.userDataDir
    workspacePath = mkdtempSync(join(tmpdir(), 'orca-isolation-workspace-'))
    seedHome(testState.fakeHomeDir)
  })

  afterEach(() => {
    resetAgentConfigIsolationForTests()
    rmSync(testState.fakeHomeDir, { recursive: true, force: true })
    rmSync(workspacePath, { recursive: true, force: true })
    if (testState.previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = testState.previousUserDataPath
    }
  })

  it('is off when unconfigured, so processes that never opt in keep current behavior', () => {
    expect(isExternalAgentConfigIsolated()).toBe(false)
  })

  it('follows the live settings reader', () => {
    let isolated = false
    configureAgentConfigIsolation(() => ({ isolateExternalAgentConfig: isolated }))
    expect(isExternalAgentConfigIsolated()).toBe(false)
    isolated = true
    expect(isExternalAgentConfigIsolated()).toBe(true)
  })

  it('fails closed when the settings reader throws', () => {
    configureAgentConfigIsolation(() => {
      throw new Error('store unavailable')
    })
    expect(isExternalAgentConfigIsolated()).toBe(true)
  })

  it('forces status hooks off even when the hooks setting is on', () => {
    expect(
      isAgentStatusHooksEnabled({ agentStatusHooksEnabled: true, isolateExternalAgentConfig: true })
    ).toBe(false)
    expect(isAgentStatusHooksEnabled({ agentStatusHooksEnabled: true })).toBe(true)
  })

  it('leaves every file outside userData byte-identical when isolated', async () => {
    configureAgentConfigIsolation(() => ({ isolateExternalAgentConfig: true }))
    const before = snapshotTree(testState.fakeHomeDir, testState.userDataDir)

    await runEveryGatedWriter(workspacePath)

    expect(snapshotTree(testState.fakeHomeDir, testState.userDataDir)).toEqual(before)
    // The Orca-owned Codex runtime config still gets trust, so launches keep working.
    const runtimeToml = readFileSync(
      join(testState.userDataDir, 'codex-runtime-home', 'home', 'config.toml'),
      'utf-8'
    )
    expect(runtimeToml).toContain('trust_level = "trusted"')
  })

  it('runs every release task, then rejects when any failed so isolation is not saved', async () => {
    const calls: string[] = []
    onBeforeAgentConfigIsolation(async () => {
      calls.push('first')
      throw new Error('restore failed')
    })
    onBeforeAgentConfigIsolation(async () => {
      calls.push('second')
    })

    await expect(releaseExternalAgentStateBeforeIsolation()).rejects.toThrow(
      'Could not restore agent logins'
    )
    expect(calls).toEqual(['first', 'second'])
  })

  it('lifts isolation only inside the release chain', async () => {
    configureAgentConfigIsolation(() => ({ isolateExternalAgentConfig: true }))
    const seenInsideRelease: boolean[] = []
    onBeforeAgentConfigIsolation(async () => {
      await Promise.resolve()
      seenInsideRelease.push(isExternalAgentConfigIsolated())
    })
    let seenConcurrently: boolean | null = null
    const concurrent = (async () => {
      await Promise.resolve()
      seenConcurrently = isExternalAgentConfigIsolated()
    })()

    await Promise.all([releaseExternalAgentStateBeforeIsolation(), concurrent])

    expect(seenInsideRelease).toEqual([false])
    expect(seenConcurrently).toBe(true)
    expect(isExternalAgentConfigIsolated()).toBe(true)
  })

  it('keeps the release scope through mutation queues that were busy before the release', async () => {
    configureAgentConfigIsolation(() => ({ isolateExternalAgentConfig: true }))
    // Mirrors serializeMutation in the account service and the runtime-auth service.
    const createQueue = () => {
      let queue: Promise<unknown> = Promise.resolve()
      return <T>(fn: () => Promise<T>): Promise<T> => {
        const next = queue.then(fn)
        queue = next.catch(() => {})
        return next
      }
    }
    const accountQueue = createQueue()
    const authQueue = createQueue()
    let unblock!: () => void
    const busy = new Promise<void>((resolve) => (unblock = resolve))
    void accountQueue(() => busy)
    void authQueue(() => busy)
    let seenInsideQueuedRestore: boolean | null = null
    onBeforeAgentConfigIsolation(() =>
      accountQueue(() =>
        authQueue(async () => {
          seenInsideQueuedRestore = isExternalAgentConfigIsolated()
        })
      )
    )

    const release = releaseExternalAgentStateBeforeIsolation()
    unblock()
    await release

    expect(seenInsideQueuedRestore).toBe(false)
    expect(isExternalAgentConfigIsolated()).toBe(true)
  })

  it('treats the release-to-persist window as isolated for everyone outside the release', async () => {
    let persisted = false
    configureAgentConfigIsolation(() => ({ isolateExternalAgentConfig: persisted }))
    let seenInsideRelease: boolean | null = null
    onBeforeAgentConfigIsolation(async () => {
      seenInsideRelease = isExternalAgentConfigIsolated()
    })

    await releaseExternalAgentStateBeforeIsolation()

    // Not yet persisted: a concurrent account selection must already see isolation on.
    expect(seenInsideRelease).toBe(false)
    expect(isExternalAgentConfigIsolated()).toBe(true)
    persisted = true
    expect(isExternalAgentConfigIsolated()).toBe(true)
    persisted = false
    // Settled by the persisted read, so turning isolation off later takes effect.
    expect(isExternalAgentConfigIsolated()).toBe(false)
  })

  it('reopens nothing when the release fails', async () => {
    configureAgentConfigIsolation(() => ({ isolateExternalAgentConfig: false }))
    onBeforeAgentConfigIsolation(async () => {
      throw new Error('restore failed')
    })

    await expect(releaseExternalAgentStateBeforeIsolation()).rejects.toThrow()

    expect(isExternalAgentConfigIsolated()).toBe(false)
  })

  it('detects only the off-to-on transition', () => {
    expect(isIsolationTurningOn({}, { isolateExternalAgentConfig: true })).toBe(true)
    expect(
      isIsolationTurningOn(
        { isolateExternalAgentConfig: true },
        { isolateExternalAgentConfig: true }
      )
    ).toBe(false)
    expect(isIsolationTurningOn({}, { isolateExternalAgentConfig: false })).toBe(false)
    expect(isIsolationTurningOn({}, {})).toBe(false)
  })

  it('reports a turn-off only when isolation was on before', () => {
    expect(didIsolationTurnOff({ isolateExternalAgentConfig: true }, {})).toBe(true)
    expect(didIsolationTurnOff({}, { isolateExternalAgentConfig: true })).toBe(false)
    expect(didIsolationTurnOff({}, {})).toBe(false)
  })

  it('skips Claude credential sync before it reads the managed accounts', async () => {
    const reads = await countManagedAccountReadsDuringSync(true)
    expect(reads).toBe(0)
    // Negative control: without isolation the same sync does consult the accounts.
    expect(await countManagedAccountReadsDuringSync(false)).toBeGreaterThan(0)
  })

  it('negative control: the same trust writers do touch HOME when not isolated', () => {
    configureAgentConfigIsolation(() => ({ isolateExternalAgentConfig: false }))
    const before = snapshotTree(testState.fakeHomeDir, testState.userDataDir)

    markCursorWorkspaceTrusted(workspacePath)
    markCopilotFolderTrusted(workspacePath)

    expect(snapshotTree(testState.fakeHomeDir, testState.userDataDir)).not.toEqual(before)
  })
})
