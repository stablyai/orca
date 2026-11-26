import {
  isAgentRpcCaller,
  type RpcCallerIdentity
} from '../../../runtime/rpc/callers/rpc-caller-identity'

const RECENT_PAIRED_ECHO_MS = 300
// Cover async OAuth/SSO iframe handshakes for paired viewers without loosening desktop external-app guards.
const PAIRED_VIEWER_CREDIT_WINDOW_MS = 4_500

function isFreshCredit(at: number, now: number): boolean {
  const elapsed = now - at
  return elapsed >= 0 && elapsed <= PAIRED_VIEWER_CREDIT_WINDOW_MS
}

type Runner = {
  pairedDeviceId: string | null
  /** A person sent it: a viewer's relayed click or key press, not an agent's CLI. */
  person: boolean
}

/** The paired client whose click or key press reached a tab last, so a tab it opens follows that client. */
export class BrowserPageInputCredit {
  // The command each page is running; queued commands run one at a time per page.
  private readonly runnerByPageId = new Map<string, Runner>()
  private readonly recentPairedByPageId = new Map<
    string,
    { pairedDeviceId: string; tabId?: string; endedAt: number }
  >()
  private readonly creditByTabId = new Map<string, { pairedDeviceId: string; at: number }>()
  // The same input, for what the page prints; opening a tab doesn't spend it.
  private readonly printCreditByTabId = new Map<string, { pairedDeviceId: string; at: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Nothing to credit or clear: no command is running and no credit is held. */
  get idle(): boolean {
    if (this.recentPairedByPageId.size > 0) {
      const now = this.now()
      for (const [pageId, recent] of this.recentPairedByPageId) {
        if (now - recent.endedAt > RECENT_PAIRED_ECHO_MS) {
          this.recentPairedByPageId.delete(pageId)
        }
      }
    }
    return (
      this.runnerByPageId.size === 0 &&
      this.recentPairedByPageId.size === 0 &&
      this.creditByTabId.size === 0 &&
      this.printCreditByTabId.size === 0
    )
  }

  /** Runs one queued command on the page, so input it delivers is credited to its caller. */
  async during<T>(
    browserPageId: string,
    caller: RpcCallerIdentity | undefined,
    execute: () => Promise<T>
  ): Promise<T> {
    const runner: Runner = {
      // An agent's CLI moves no one's view, even when it calls with a device's pairing.
      pairedDeviceId:
        caller?.kind === 'paired-device' && !isAgentRpcCaller(caller) ? caller.deviceId : null,
      person: caller !== undefined && !isAgentRpcCaller(caller)
    }
    this.runnerByPageId.set(browserPageId, runner)
    if (!runner.pairedDeviceId) {
      this.recentPairedByPageId.delete(browserPageId)
    }
    try {
      return await execute()
    } finally {
      if (this.runnerByPageId.get(browserPageId) === runner) {
        this.runnerByPageId.delete(browserPageId)
        if (runner.pairedDeviceId) {
          const existing = this.recentPairedByPageId.get(browserPageId)
          this.recentPairedByPageId.set(browserPageId, {
            pairedDeviceId: runner.pairedDeviceId,
            tabId: existing?.tabId,
            endedAt: this.now()
          })
        }
      }
    }
  }

  /** The command running on the page now is a person's, so input reaching it is theirs. */
  isRunningPersonCommand(browserPageId: string): boolean {
    const active = this.runnerByPageId.get(browserPageId)
    if (active) {
      return active.person
    }
    const recent = this.recentPairedByPageId.get(browserPageId)
    return Boolean(recent && this.now() - recent.endedAt <= RECENT_PAIRED_ECHO_MS)
  }

  /** Activating input reached the page; the running command's paired client, if any, owns what it opens. */
  creditInput(browserTabId: string, browserPageId: string, { printable = true } = {}): void {
    const now = this.now()
    const active = this.runnerByPageId.get(browserPageId)
    const recent = !active ? this.recentPairedByPageId.get(browserPageId) : undefined
    const pairedDeviceId =
      active?.pairedDeviceId ??
      (recent && now - recent.endedAt <= RECENT_PAIRED_ECHO_MS ? recent.pairedDeviceId : null)
    if (!pairedDeviceId) {
      this.withdraw(browserTabId)
      return
    }
    if (active?.pairedDeviceId) {
      this.recentPairedByPageId.set(browserPageId, {
        pairedDeviceId: active.pairedDeviceId,
        tabId: browserTabId,
        endedAt: now
      })
    } else if (recent) {
      recent.tabId = browserTabId
    }
    // Unconsumed credits for tabs that opened nothing would otherwise pile up.
    for (const credits of [this.creditByTabId, this.printCreditByTabId]) {
      for (const [tabId, credit] of credits) {
        if (!isFreshCredit(credit.at, now)) {
          credits.delete(tabId)
        }
      }
    }
    this.creditByTabId.set(browserTabId, { pairedDeviceId, at: now })
    if (printable) {
      this.printCreditByTabId.set(browserTabId, { pairedDeviceId, at: now })
    } else {
      this.printCreditByTabId.delete(browserTabId)
    }
  }

  /** An agent acts on the tab now: what the page does next is not the earlier input's. */
  withdraw(browserTabId: string): void {
    this.creditByTabId.delete(browserTabId)
    this.printCreditByTabId.delete(browserTabId)
    for (const [pageId, recent] of this.recentPairedByPageId) {
      if (pageId === browserTabId || recent.tabId === browserTabId) {
        this.recentPairedByPageId.delete(pageId)
      }
    }
  }

  /** Whose input just reached the tab, for a print it makes; a tab that input opened doesn't spend it. */
  printer(browserTabId: string): string | null {
    const credit = this.printCreditByTabId.get(browserTabId)
    return credit && isFreshCredit(credit.at, this.now()) ? credit.pairedDeviceId : null
  }

  peek(browserTabId: string): string | null {
    const credit = this.creditByTabId.get(browserTabId)
    return credit && isFreshCredit(credit.at, this.now()) ? credit.pairedDeviceId : null
  }

  /** Single-use, like the input gesture it accompanies: one click cannot steer a second tab. */
  consume(browserTabId: string): string | null {
    const credit = this.creditByTabId.get(browserTabId)
    this.creditByTabId.delete(browserTabId)
    return credit && isFreshCredit(credit.at, this.now()) ? credit.pairedDeviceId : null
  }
}
