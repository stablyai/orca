import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type * as NodeOs from 'node:os'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createStore,
  getRuntimeCodexAuthPath,
  getRuntimeCodexHomePath,
  getSystemCodexAuthPath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'
import type { CodexRuntimeHomeService } from './runtime-home-service'

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
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const login = createCodexAuthJson('me@example.com', 'acct-me', 'external-login')

async function mirrorRouteService(): Promise<CodexRuntimeHomeService> {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  // The mirror route: the real-home lane is not routable (custom CODEX_HOME or its gate is off).
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only getSettings/updateSettings, which the harness store implements.
  return new CodexRuntimeHomeService(createStore(createSettings()) as never)
}

function loginInSystemHome(): void {
  mkdirSync(dirname(getSystemCodexAuthPath()), { recursive: true })
  writeFileSync(getSystemCodexAuthPath(), login, 'utf-8')
}

describe("the catalog probe's home prep on the mirror route", () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it('brings a login made in ~/.codex into the mirror before the probe reads it', async () => {
    const service = await mirrorRouteService()
    // A launch while signed out seeded the mirror with nothing.
    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
    // `codex login` in an outside terminal writes only ~/.codex.
    loginInSystemHome()

    service.prepareHostCodexHomeForReadOnlyAppServer(getRuntimeCodexHomePath())

    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(login)
  })

  it('seeds a mirror no launch has prepared yet', async () => {
    const service = await mirrorRouteService()
    loginInSystemHome()

    service.prepareHostCodexHomeForReadOnlyAppServer(getRuntimeCodexHomePath())

    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(login)
  })

  it('leaves every other home alone', async () => {
    const service = await mirrorRouteService()
    loginInSystemHome()

    service.prepareHostCodexHomeForReadOnlyAppServer(join(testState.fakeHomeDir, 'account-home'))

    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
  })
})
