import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  createCodexAuthJson,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

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

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness doubles implement every member the add-account login path reaches; this test drives the service only through addAccount, cancelPendingLogin and the login URL subscription.
const asServiceDouble = <T>(double: unknown): T => double as T

type StubLoginChild = EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  kill: () => boolean
  exitCode: number | null
  signalCode: string | null
}

function createStubLoginChild(): StubLoginChild {
  const child: StubLoginChild = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true
  })

  child.kill = vi.fn(() => {
    child.exitCode = 143
    return true
  })
  return child
}

async function createServiceWithHangingLogin(): Promise<{
  service: {
    addAccount: () => Promise<{ accounts: { email: string }[] }>
    selectAccount: (accountId: string | null) => Promise<unknown>
    cancelPendingLogin: () => boolean
    getPendingLoginUrl: () => string | null
    onPendingLoginUrlChanged: (listener: (url: string | null) => void) => void
  }
  children: StubLoginChild[]

  loginHomes: string[]
}> {
  vi.resetModules()
  const children: StubLoginChild[] = []
  const loginHomes: string[] = []
  vi.doMock('node:child_process', () => ({
    execFileSync: vi.fn(),
    spawn: vi.fn((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      loginHomes.push(options.env.CODEX_HOME ?? '')
      const child = createStubLoginChild()
      children.push(child)
      return child
    })
  }))
  vi.doMock('../codex-cli/command', () => ({
    resolveCodexCommand: () => 'codex'
  }))
  const { CodexAccountService } = await import('./service')
  const service = new CodexAccountService(
    asServiceDouble(createStore(createSettings())),
    asServiceDouble(createRateLimits()),
    asServiceDouble(createRuntimeHome())
  )
  return { service, children, loginHomes }
}

describe('CodexAccountService abandoned login', () => {
  registerCodexAccountsTestHomes()

  afterEach(() => {
    vi.doUnmock('node:child_process')
    vi.doUnmock('../codex-cli/command')
  })

  it('supersedes the login a closed Settings pane abandoned instead of queueing behind it', async () => {
    const { service, children } = await createServiceWithHangingLogin()
    const abandoned = service.addAccount()
    const abandonedRejection = expect(abandoned).rejects.toThrow('Codex sign-in was cancelled.')
    await vi.waitUntil(() => children.length === 1)

    const retry = service.addAccount()
    const retryRejection = expect(retry).rejects.toThrow()

    await abandonedRejection
    expect(children[0].kill).toHaveBeenCalledTimes(1)

    await vi.waitUntil(() => children.length === 2)
    expect(children[1].kill).not.toHaveBeenCalled()

    service.cancelPendingLogin()
    await retryRejection
  })

  it('frees the queue for a plain account switch too, not only for another add', async () => {
    const { service, children } = await createServiceWithHangingLogin()
    const abandoned = service.addAccount()
    const abandonedRejection = expect(abandoned).rejects.toThrow('Codex sign-in was cancelled.')
    await vi.waitUntil(() => children.length === 1)

    await service.selectAccount(null)
    await abandonedRejection
    expect(children[0].kill).toHaveBeenCalled()
  })

  it('refuses to cancel a sign-in that already wrote credentials, and keeps the account', async () => {
    const { service, children, loginHomes } = await createServiceWithHangingLogin()
    const pending = service.addAccount()
    await vi.waitUntil(() => children.length === 1)

    writeFileSync(
      join(loginHomes[0], 'auth.json'),
      createCodexAuthJson('user@example.com', 'provider-account-1', 'refresh-token'),
      'utf-8'
    )

    expect(service.cancelPendingLogin()).toBe(false)
    expect(children[0].kill).not.toHaveBeenCalled()

    children[0].emit('close', 0)
    const accounts = await pending
    expect(accounts.accounts.map((account) => account.email)).toEqual(['user@example.com'])
    expect(existsSync(join(loginHomes[0], 'auth.json'))).toBe(true)
  })

  it('reports whether a pending login was there to cancel', async () => {
    const { service, children } = await createServiceWithHangingLogin()
    const pending = service.addAccount()
    const rejection = expect(pending).rejects.toThrow('Codex sign-in was cancelled.')
    await vi.waitUntil(() => children.length === 1)

    expect(service.cancelPendingLogin()).toBe(true)
    await rejection
    expect(service.cancelPendingLogin()).toBe(false)
  })

  it('publishes the sign-in link codex prints and drops it when the login ends', async () => {
    const { service, children } = await createServiceWithHangingLogin()
    const published: (string | null)[] = []
    service.onPendingLoginUrlChanged((url) => published.push(url))

    const pending = service.addAccount()
    const rejection = expect(pending).rejects.toThrow('Codex sign-in was cancelled.')
    await vi.waitUntil(() => children.length === 1)

    const authUrl = 'https://auth.openai.com/oauth/authorize?client_id=orca&state=abc'
    children[0].stdout.write(
      `Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\n${authUrl}\n`
    )
    await vi.waitUntil(() => service.getPendingLoginUrl() === authUrl)
    expect(published).toEqual([authUrl])

    service.cancelPendingLogin()
    await rejection

    expect(service.getPendingLoginUrl()).toBeNull()
    expect(published).toEqual([authUrl, null])
  })
})
