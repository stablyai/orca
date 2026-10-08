import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createStore,
  getRuntimeCodexAuthPath,
  getSharedRuntimeAuthProvenancePath,
  getSystemCodexAuthPath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'
import type { CodexRuntimeHomeService } from './runtime-home-service'
import type { GlobalSettings } from '../../shared/global-settings-types'

vi.mock('../codex/codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const paneLogin = createCodexAuthJson('me@example.com', 'acct-me', 'pane-login')

async function createService(settings: GlobalSettings): Promise<CodexRuntimeHomeService> {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only getSettings/updateSettings, which the harness store implements.
  return new CodexRuntimeHomeService(createStore(settings) as never)
}

async function launchOnMirror(): Promise<void> {
  const service = await createService(createSettings())
  expect(service.prepareForCodexLaunch()).not.toBeNull()
}

async function launchOnRealHome(platform: NodeJS.Platform = 'win32'): Promise<void> {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  const service = await createService(createSettings({ realHomeRoutable: true }))
  expect(service.prepareForCodexLaunch()).toBeNull()
}

describe('copying a login made inside Orca into an empty ~/.codex on Windows', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    teardownRuntimeHomeTest()
  })

  it('copies it when the mirror was seeded from an empty ~/.codex', async () => {
    await launchOnMirror()
    writeFileSync(getRuntimeCodexAuthPath(), paneLogin, 'utf-8')

    await launchOnRealHome()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(paneLogin)
    expect(JSON.parse(readFileSync(getSharedRuntimeAuthProvenancePath(), 'utf-8'))).toEqual({
      owner: 'system-default',
      authJson: paneLogin
    })
  })

  it('leaves a ~/.codex that has a login alone', async () => {
    await launchOnMirror()
    writeFileSync(getRuntimeCodexAuthPath(), paneLogin, 'utf-8')
    const ownLogin = createCodexAuthJson('me@example.com', 'acct-me', 'own')
    writeFileSync(getSystemCodexAuthPath(), ownLogin, 'utf-8')

    await launchOnRealHome()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(ownLogin)
  })

  it('does not undo a later logout from ~/.codex', async () => {
    await launchOnMirror()
    writeFileSync(getRuntimeCodexAuthPath(), paneLogin, 'utf-8')
    await launchOnRealHome()
    rmSync(getSystemCodexAuthPath())

    await launchOnRealHome()

    expect(existsSync(getSystemCodexAuthPath())).toBe(false)
  })

  it('copies nothing when the mirror was seeded from a ~/.codex login', async () => {
    writeFileSync(
      getSystemCodexAuthPath(),
      createCodexAuthJson('me@example.com', 'acct-me', 'seeded'),
      'utf-8'
    )
    await launchOnMirror()
    rmSync(getSystemCodexAuthPath())
    writeFileSync(getRuntimeCodexAuthPath(), paneLogin, 'utf-8')

    await launchOnRealHome()

    expect(existsSync(getSystemCodexAuthPath())).toBe(false)
  })

  it.each([
    ['managed', { owner: 'managed', accountId: 'account-1' }],
    ['pending', { owner: 'pending' }]
  ])('copies nothing for %s provenance', async (_label, provenance) => {
    await launchOnMirror()
    writeFileSync(getRuntimeCodexAuthPath(), paneLogin, 'utf-8')
    writeFileSync(getSharedRuntimeAuthProvenancePath(), `${JSON.stringify(provenance)}\n`)

    await launchOnRealHome()

    expect(existsSync(getSystemCodexAuthPath())).toBe(false)
  })

  it('does nothing on macOS or Linux', async () => {
    await launchOnMirror()
    writeFileSync(getRuntimeCodexAuthPath(), paneLogin, 'utf-8')

    await launchOnRealHome('darwin')

    expect(existsSync(getSystemCodexAuthPath())).toBe(false)
  })
  it("does not pull Orca's login in after a later logout when ~/.codex had its own", async () => {
    await launchOnMirror()
    writeFileSync(getRuntimeCodexAuthPath(), paneLogin, 'utf-8')
    const ownLogin = createCodexAuthJson('other@example.com', 'acct-other', 'own')
    writeFileSync(getSystemCodexAuthPath(), ownLogin, 'utf-8')
    await launchOnRealHome()
    // Retained panes on the mirror follow ~/.codex, as on old mirror launches.
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(ownLogin)
    rmSync(getSystemCodexAuthPath())

    await launchOnRealHome()

    expect(existsSync(getSystemCodexAuthPath())).toBe(false)
  })

  it('stays one-shot when the snapshot after the copy fails', async () => {
    await launchOnMirror()
    writeFileSync(getRuntimeCodexAuthPath(), paneLogin, 'utf-8')
    const snapshotPath = join(
      testState.userDataDir,
      'codex-runtime-home',
      'system-default-auth.json'
    )
    rmSync(snapshotPath, { force: true })
    mkdirSync(join(snapshotPath, 'blocked'), { recursive: true })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await launchOnRealHome()

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(paneLogin)
    expect(JSON.parse(readFileSync(getSharedRuntimeAuthProvenancePath(), 'utf-8'))).toEqual({
      owner: 'system-default',
      authJson: paneLogin
    })
  })

  it('copies it before a usage poll reads ~/.codex', async () => {
    await launchOnMirror()
    writeFileSync(getRuntimeCodexAuthPath(), paneLogin, 'utf-8')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const service = await createService(createSettings({ realHomeRoutable: true }))

    expect(service.prepareForRateLimitFetch()).toMatchObject({ kind: 'ready' })

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(paneLogin)
  })
})
