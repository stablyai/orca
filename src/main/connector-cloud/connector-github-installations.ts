// The GitHub installations a hello lists for every bot, as GET /github/state last answered.
import {
  BOT_GITHUB_OFF,
  gitHubOn,
  type ConnectorGitHubState
} from '../../shared/connector-bot-github-contract'
import {
  BOT_SLACK_DESKTOP_ERRORS,
  type BotSlackResult
} from '../../shared/connector-bot-slack-contract'

// New installs and unlinks reach the hello within this, or at once when a GitHub surface reads the state.
const STALE_MS = 10 * 60_000

const LIST_CHANGING_ERRORS = new Set([BOT_GITHUB_OFF, BOT_SLACK_DESKTOP_ERRORS.signedOut])

type Known = { account: string; ids: string[]; at: number }

export class ConnectorGitHubInstallations {
  private known: Known | null = null
  private asking: Promise<unknown> | null = null
  // Reads are numbered when sent, so an older answer never replaces a newer one.
  private sent = 0
  private applied = 0
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly deps: {
      account: () => string | null
      fetchState: () => Promise<BotSlackResult<ConnectorGitHubState>>
      now?: () => number
    }
  ) {}

  /** For a hello: the signed-in account's installation ids, or none until the cloud has answered for it. */
  ids(): string[] {
    const account = this.deps.account()
    if (!account) {
      return []
    }
    const known = this.known?.account === account ? this.known : null
    if (!known || this.now() - known.at >= STALE_MS) {
      void this.ask(account)
    }
    return known?.ids ?? []
  }

  /**
   * Before a first hello: waits, at most `timeoutMs`, for the account's first answer, so the hello
   * lists its installs instead of a second hello following with them.
   */
  async firstAnswer(timeoutMs: number): Promise<void> {
    const account = this.deps.account()
    if (!account || this.known?.account === account) {
      return
    }
    this.ids()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.asking,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
    ]).finally(() => clearTimeout(timer))
  }

  /** Reads the state for `account` through `read` and keeps its installs; GitHub off or signed out lists none. */
  async track(
    account: string | null,
    read: () => Promise<BotSlackResult<ConnectorGitHubState>>
  ): Promise<BotSlackResult<ConnectorGitHubState>> {
    const request = ++this.sent
    const result = await read().catch(() => ({ ok: false as const, error: 'failed' }))
    if (account && request > this.applied) {
      this.applied = request
      this.keep(account, result)
    }
    return result
  }

  private keep(account: string, result: BotSlackResult<ConnectorGitHubState>): void {
    const before = this.known?.account === account ? this.known.ids : []
    // Unreachable or failing: keep what was known, so a blip never takes bots off GitHub. Only an
    // answer, GitHub off, or signed out changes the list.
    if (!result.ok && !LIST_CHANGING_ERRORS.has(result.error)) {
      return
    }
    const ids =
      result.ok && gitHubOn(result.value)
        ? result.value.installations.map((installation) => installation.installationId)
        : []
    this.known = { account, ids, at: this.now() }
    if (ids.join(',') !== before.join(',')) {
      this.listeners.forEach((listener) => listener())
    }
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener)
  }

  private ask(account: string): void {
    this.asking ??= this.track(account, this.deps.fetchState).finally(() => {
      this.asking = null
    })
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
