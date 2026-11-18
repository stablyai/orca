import { describe, expect, it, vi } from 'vitest'
import type { ConnectorGitHubState } from '../../shared/connector-bot-github-contract'
import { ConnectorGitHubInstallations } from './connector-github-installations'

const linked: ConnectorGitHubState = {
  installUrl: 'https://connector.example/github/install?state=s',
  account: { userId: '42', login: 'dana' },
  installations: [{ installationId: '7', accountLogin: 'acme', repositories: null }],
  defaultBotId: null
}

function subject(account: () => string | null = () => 'ada') {
  let now = 0
  const fetchState = vi.fn().mockResolvedValue({ ok: true, value: linked })
  const installations = new ConnectorGitHubInstallations({ account, fetchState, now: () => now })
  const changed = vi.fn()
  installations.onChange(changed)
  return { installations, fetchState, changed, advance: (ms: number) => (now += ms) }
}

describe('ConnectorGitHubInstallations', () => {
  it('lists none until the cloud answers, then the installs, and asks again only once stale', async () => {
    const { installations, fetchState, changed, advance } = subject()
    expect(installations.ids()).toEqual([])
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(installations.ids()).toEqual(['7'])
    expect(fetchState).toHaveBeenCalledTimes(1)

    advance(10 * 60_000)
    fetchState.mockResolvedValue({ ok: true, value: { ...linked, account: null } })
    expect(installations.ids()).toEqual(['7'])
    // Unlinked: no bot answers on GitHub any more.
    await vi.waitFor(() => expect(installations.ids()).toEqual([]))
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('takes a state read from a GitHub surface at once, and lists none for a cloud with GitHub off', async () => {
    const { installations, fetchState, changed } = subject()
    await installations.track('ada', async () => ({ ok: true, value: linked }))
    expect(installations.ids()).toEqual(['7'])
    expect(fetchState).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledTimes(1)

    await installations.track('ada', async () => ({ ok: false, error: 'github_off' }))
    expect(installations.ids()).toEqual([])
  })

  it('never lists one account’s installs for another, and asks nothing signed out', async () => {
    let account: string | null = 'ada'
    const { installations, fetchState } = subject(() => account)
    await installations.track('ada', async () => ({ ok: true, value: linked }))
    account = 'bo'
    expect(installations.ids()).toEqual([])
    account = null
    fetchState.mockClear()
    expect(installations.ids()).toEqual([])
    expect(fetchState).not.toHaveBeenCalled()
  })

  it('never lets an older read replace a newer one', async () => {
    const { installations } = subject()
    let answerOld: (value: { ok: true; value: ConnectorGitHubState }) => void = () => {}
    const old = installations.track('ada', () => new Promise((resolve) => (answerOld = resolve)))
    // An unlink seen afterwards wins, even though the earlier read answers last.
    await installations.track('ada', async () => ({
      ok: true,
      value: { ...linked, account: null }
    }))
    answerOld({ ok: true, value: linked })
    await old
    expect(installations.ids()).toEqual([])
  })

  it('keeps the known installs when the cloud can’t be reached', async () => {
    const { installations, changed } = subject()
    await installations.track('ada', async () => ({ ok: true, value: linked }))
    await installations.track('ada', async () => ({ ok: false, error: 'cloud_unreachable' }))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(installations.ids()).toEqual(['7'])

    await installations.track('ada', async () => ({ ok: false, error: 'signed_out' }))
    expect(installations.ids()).toEqual([])
  })
})
