import { describe, expect, it, vi } from 'vitest'
import { CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE } from '../../shared/connector-cloud-features'
import { ConnectorCloud } from './connector-cloud'
import { pollClientHarness, settle } from './connector-poll-client.test-fixture'
import { CONNECTOR_REHELLO_SPREAD_MS } from './connector-poll-control'
import { fakeMachine, fakeSeam } from './fake-connector-seam.test-fixture'

const h = pollClientHarness()

// The connector as the app runs it, against the fake cloud: what bots.list says it takes.
function connector() {
  const seam = fakeSeam()
  const onStatusChanged = vi.fn()
  let account: string | null = 'ada'
  const cloud = new ConnectorCloud({
    userDataPath: h.userDataPath,
    origin: h.fake.origin,
    machine: fakeMachine(() => seam),
    account: () => account,
    isFenced: () => false,
    mintFor: (signedIn) => h.fake.mintFor(signedIn),
    fetchImpl: h.fake.fetch,
    onStatusChanged
  })
  cloud.connect()
  // Signs out, which stops its client.
  const stop = () => {
    account = null
    cloud.accountChanged()
  }
  return { cloud, onStatusChanged, stop }
}

describe('what bots.list says of the Slack intro switch', () => {
  it('offers it once the cloud lists it, and tells the app when that changes', async () => {
    h.fake.features = ['webhooks']
    const { cloud, onStatusChanged, stop } = connector()
    await settle()
    expect(cloud.botListFacts().slackChannelHello).toBe(false)

    onStatusChanged.mockClear()
    h.fake.features = ['webhooks', CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE]
    h.fake.answerPoll({ status: 409, body: { error: 'hello_required' } })
    // A 409's new hello waits out its spread.
    await settle(CONNECTOR_REHELLO_SPREAD_MS + 1_000)
    expect(cloud.botListFacts().slackChannelHello).toBe(true)
    expect(onStatusChanged).toHaveBeenCalled()

    // The same list again changes nothing it says.
    onStatusChanged.mockClear()
    h.fake.answerPoll({ status: 409, body: { error: 'hello_required' } })
    // A 409's new hello waits out its spread.
    await settle(CONNECTOR_REHELLO_SPREAD_MS + 1_000)
    expect(onStatusChanged).not.toHaveBeenCalled()
    stop()
  })

  it('stops offering it, and says so, once the cloud stops the connection until sign-in', async () => {
    h.fake.features = [CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE]
    const { cloud, onStatusChanged, stop } = connector()
    await settle()
    expect(cloud.botListFacts().slackChannelHello).toBe(true)

    onStatusChanged.mockClear()
    h.fake.answerPoll({ status: 403, body: { error: 'recent_sign_in_required' } })
    await settle(30_000)
    expect(cloud.liveCloudFeatures()).toBeNull()
    expect(cloud.botListFacts().slackChannelHello).toBe(false)
    expect(onStatusChanged).toHaveBeenCalled()
    stop()
  })

  it('stops offering it while the cloud can’t be reached, though its last answer stays cached', async () => {
    h.fake.features = [CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE]
    const { cloud, stop } = connector()
    await settle()
    expect(cloud.botListFacts().slackChannelHello).toBe(true)

    h.fake.online = false
    h.fake.answerPoll({ status: 503, body: {} })
    await settle(30_000)
    expect(cloud.status()).toBe('unreachable')
    expect(cloud.cloudFeatures()?.has(CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE)).toBe(true)
    expect(cloud.botListFacts().slackChannelHello).toBe(false)
    stop()
  })
})
