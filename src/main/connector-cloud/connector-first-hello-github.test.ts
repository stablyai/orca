import { describe, expect, it, vi } from 'vitest'
import type { ConnectorGitHubState } from '../../shared/connector-bot-github-contract'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import { ConnectorGitHubInstallations } from './connector-github-installations'
import { pollClientHarness, settle } from './connector-poll-client.test-fixture'
import { FAKE_BOT, fakeSeam } from './fake-connector-seam.test-fixture'

const h = pollClientHarness()

const linked: ConnectorGitHubState = {
  installUrl: 'https://connector.example/github/install?state=s',
  account: { userId: '42', login: 'dana' },
  installations: [{ installationId: '7', accountLogin: 'acme', repositories: null }],
  defaultBotId: null
}

function startWithGitHub(answerAfterMs: number) {
  const fetchState = vi.fn(
    () =>
      new Promise<{ ok: true; value: ConnectorGitHubState }>((resolve) =>
        // ast-grep-ignore: test-no-real-time-wait -- the poll harness fakes setTimeout; settle() advances it
        setTimeout(() => resolve({ ok: true, value: linked }), answerAfterMs)
      )
  )
  const installations = new ConnectorGitHubInstallations({ account: () => 'ada', fetchState })
  const seam = fakeSeam()
  const started = h.startClient(seam, undefined, (machine) => {
    machine.bots = () => [
      {
        ...FAKE_BOT,
        workspaces: installations
          .ids()
          .map((workspaceId) => ({ source: 'github' as const, workspaceId, members: [] }))
      }
    ]
    machine.beforeFirstHello = () => installations.firstAnswer(3_000)
  })
  installations.onChange(() => started.client.sayChanged())
  return { ...started, fetchState }
}

describe('the first hello of a host with a GitHub bot', () => {
  it('waits for the first GitHub read, so one hello goes out with the installs', async () => {
    const { client, fetchState } = startWithGitHub(500)
    await settle(1_000)
    expect(fetchState).toHaveBeenCalledTimes(1)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)
    expect(h.fake.hellos[0]).toMatchObject({
      bots: [{ workspaces: [{ source: 'github', workspaceId: '7' }] }]
    })
    client.stop()
  })

  it('a GitHub read slower than the bound holds the hello no longer than it', async () => {
    const { client } = startWithGitHub(60_000)
    await settle(3_500)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.hello)).toHaveLength(1)
    client.stop()
  })
})
