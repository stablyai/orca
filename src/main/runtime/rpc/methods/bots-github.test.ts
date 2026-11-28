import { afterEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { ConnectorGitHubState } from '../../../../shared/connector-bot-github-contract'
import type { RpcContext } from '../core'
import { BOT_GITHUB_METHODS } from './bots-github'

const gh = vi.hoisted(() => ({ token: '', runs: 0 }))
vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: async () => {
    gh.runs++
    if (!gh.token) {
      throw Object.assign(new Error('not logged in'), { code: 4 })
    }
    return { stdout: `${gh.token}\n`, stderr: '' }
  }
}))

const CLOUD_STATE = {
  installUrl: 'https://github.com/apps/orca/installations/new',
  account: { userId: '1', login: 'owner' },
  installations: [{ installationId: '2', accountLogin: 'acme', repositories: null }],
  defaultBotId: null
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only these runtime members.
const context = {
  caller: { kind: 'desktop' },
  runtime: {
    connectorGitHubInstallations: null,
    getConnectorCloud: () => ({
      call: async (_path: string, _body: unknown, schema: z.ZodType) => ({
        ok: true,
        value: schema.parse(CLOUD_STATE)
      }),
      signedInAccount: () => 'account-1'
    })
  }
} as unknown as RpcContext

const stateMethod = BOT_GITHUB_METHODS.find((method) => method.name === 'bots.github.state')!

/** The host's answer as the desktop and the phone read it (the phone parses it with this schema). */
async function readAsPhone(): Promise<ConnectorGitHubState> {
  const answer = await stateMethod.handler(undefined, context)
  if (!answer.ok) {
    throw new Error(answer.error)
  }
  return ConnectorGitHubState.parse(answer.value)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('bots.github.state', () => {
  it("carries this host's gh sign-in to every client, re-read once it may have changed", async () => {
    vi.useFakeTimers()
    expect((await readAsPhone()).gh).toBe('signed-out')
    // `gh auth login` on the host: surfaces shown together share one read, a later one sees it.
    gh.token = 'gho_x'
    expect((await readAsPhone()).gh).toBe('signed-out')
    expect(gh.runs).toBe(1)
    vi.advanceTimersByTime(15_000)
    expect((await readAsPhone()).gh).toBe('signed-in')
    expect(gh.runs).toBe(2)
  })

  it('reads a gh state this build does not know as absent, keeping the rest', () => {
    const parsed = ConnectorGitHubState.parse({ ...CLOUD_STATE, gh: 'expired' })
    expect(parsed.gh).toBeUndefined()
    expect(parsed.installations).toHaveLength(1)
  })
})
