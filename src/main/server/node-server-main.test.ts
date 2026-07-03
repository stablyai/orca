import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => {
  const warnIfSharingDesktopUserData = vi.fn()
  const setAppEnvironment = vi.fn()
  const setSecretStore = vi.fn()
  const initDataPath = vi.fn()
  const registerHeadlessPtyRuntime = vi.fn()

  class NodeAppEnvironment {
    private readonly userDataPath: string

    constructor(options: { userDataPath?: string } = {}) {
      this.userDataPath =
        options.userDataPath ??
        process.env.ORCA_USER_DATA_PATH ??
        process.env.ORCA_TEST_DEFAULT_USER_DATA_PATH ??
        join(tmpdir(), 'orca-node-server-main-test')
    }

    getPath(name: string): string {
      return name === 'userData' ? this.userDataPath : join(this.userDataPath, name)
    }

    getAppPath(): string {
      return process.cwd()
    }

    onWillQuit(_handler: () => void): void {}
  }

  class NodeSecretStore {
    constructor(_options: unknown) {}
  }

  class Store {
    getSettings(): Record<string, never> {
      return {}
    }
  }

  class OrcaRuntimeService {
    syncWindowGraph = vi.fn()

    getRuntimeId(): string {
      return 'runtime-test'
    }
  }

  class OrcaRuntimeRpcServer {
    start = vi.fn(async () => undefined)

    getWebSocketEndpoint(): string {
      return 'ws://127.0.0.1:0'
    }

    createPairingOffer(): { available: false } {
      return { available: false }
    }
  }

  return {
    NodeAppEnvironment,
    NodeSecretStore,
    OrcaRuntimeRpcServer,
    OrcaRuntimeService,
    Store,
    initDataPath,
    registerHeadlessPtyRuntime,
    setAppEnvironment,
    setSecretStore,
    warnIfSharingDesktopUserData
  }
})

vi.mock('../../shared/app-environment', () => ({
  setAppEnvironment: mocks.setAppEnvironment
}))

vi.mock('../../shared/secret-store', () => ({
  setSecretStore: mocks.setSecretStore
}))

vi.mock('./node-app-environment', () => ({
  NodeAppEnvironment: mocks.NodeAppEnvironment
}))

vi.mock('./node-secret-store', () => ({
  NodeSecretStore: mocks.NodeSecretStore
}))

vi.mock('./shared-user-data-guard', () => ({
  warnIfSharingDesktopUserData: mocks.warnIfSharingDesktopUserData
}))

vi.mock('../persistence', () => ({
  Store: mocks.Store,
  initDataPath: mocks.initDataPath
}))

vi.mock('../runtime/orca-runtime', () => ({
  OrcaRuntimeService: mocks.OrcaRuntimeService
}))

vi.mock('../runtime/runtime-rpc', () => ({
  OrcaRuntimeRpcServer: mocks.OrcaRuntimeRpcServer
}))

vi.mock('../ipc/pty', () => ({
  registerHeadlessPtyRuntime: mocks.registerHeadlessPtyRuntime
}))

import { runNodeServer } from './node-server-main'

describe('runNodeServer userData warning wiring', () => {
  const prevEnv = { ...process.env }
  let dir: string
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-node-server-main-'))
    process.env = {
      ...prevEnv,
      ORCA_TEST_DEFAULT_USER_DATA_PATH: join(dir, 'default-user-data')
    }
    delete process.env.ORCA_USER_DATA_PATH
    vi.clearAllMocks()
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    log.mockRestore()
    process.env = { ...prevEnv }
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not treat the normalized inherited env var as an explicit user choice', async () => {
    await runNodeServer(['--no-pairing', '--json'])

    expect(mocks.warnIfSharingDesktopUserData).toHaveBeenCalledWith({
      userDataPath: join(dir, 'default-user-data'),
      explicitlyConfigured: false
    })
    expect(process.env.ORCA_USER_DATA_PATH).toBe(join(dir, 'default-user-data'))
  })

  it('keeps explicit env and CLI userData choices marked explicit', async () => {
    const envPath = join(dir, 'env-user-data')
    process.env.ORCA_USER_DATA_PATH = envPath
    await runNodeServer(['--no-pairing', '--json'])
    expect(mocks.warnIfSharingDesktopUserData).toHaveBeenLastCalledWith({
      userDataPath: envPath,
      explicitlyConfigured: true
    })

    const cliPath = join(dir, 'cli-user-data')
    delete process.env.ORCA_USER_DATA_PATH
    await runNodeServer(['--no-pairing', '--json', '--user-data', cliPath])
    expect(mocks.warnIfSharingDesktopUserData).toHaveBeenLastCalledWith({
      userDataPath: cliPath,
      explicitlyConfigured: true
    })
  })
})
