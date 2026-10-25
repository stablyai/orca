import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { HostAccountSignInChannel } from '../../shared/host-account-sign-in-types'
import {
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
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // oxlint-disable-line typescript/consistent-type-imports -- vi.importActual needs an inline import() type
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const DEVICE_OUTPUT =
  '1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mABCD-EFGH1\u001b[0m\n\n'

// Windows device login requires a dedicated console.
describe.skipIf(process.platform === 'win32')('CodexAccountService device-code sign-in', () => {
  registerCodexAccountsTestHomes()

  it('runs codex device auth on this host and hands its page and code to the channel', async () => {
    vi.resetModules()
    let prompted = false
    const spawnMock = vi.fn(
      (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: vi.fn()
        })
        const loginHome = options.env.CODEX_HOME!
        queueMicrotask(() => child.stdout.write(DEVICE_OUTPUT))

        void vi
          .waitFor(() => expect(prompted).toBe(true))
          .then(() => {
            const payload = Buffer.from(JSON.stringify({ email: 'remote@example.com' })).toString(
              'base64url'
            )
            writeFileSync(
              join(loginHome, 'auth.json'),
              JSON.stringify({ tokens: { id_token: `header.${payload}.signature` } }),
              'utf-8'
            )
            child.emit('close', 0)
          })
        return child
      }
    )
    vi.doMock('node:child_process', () => ({
      execFile: vi.fn(),
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'codex'
    }))

    const runtimeHome = createRuntimeHome()
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: harness fakes implement the members this add path reads.
      createStore(createSettings()) as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: harness fakes implement the members this add path reads.
      createRateLimits() as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: harness fakes implement the members this add path reads.
      runtimeHome as never
    )
    const onPrompt = vi.fn(() => {
      prompted = true
    })
    const channel: HostAccountSignInChannel = {
      signal: new AbortController().signal,
      onPrompt,
      nextCode: () => new Promise(() => {})
    }

    const state = await service.addAccountWithDeviceCode(channel)

    expect(spawnMock.mock.calls[0][1]).toEqual(['login', '--device-auth'])
    expect(onPrompt).toHaveBeenCalledExactlyOnceWith({
      url: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH1',
      needsCode: false
    })
    expect(state.accounts.map((account) => account.email)).toEqual(['remote@example.com'])

    expect(service.getPendingLoginUrl()).toBeNull()
  })
})
