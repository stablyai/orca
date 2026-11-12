// One Claude "Set up once" run: `claude setup-token` in main, the sign-in link it shows, and the code
// Claude's sign-in page hands back (pasted into Orca, typed into the waiting CLI). It reports setup
// states only; the token goes to `onToken` and nowhere else, and a pasted code is never kept.
import type { OrcaCloudAgentSetup } from '../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  runClaudeSetupToken,
  type SpawnSetupToken,
  type SubmitSetupCode
} from './claude-setup-token-runner'

export type ClaudeSetupRun = {
  /** The sign-in link for "Open again", while the CLI is waiting on it. */
  url: () => string | null
  /** Types a (normalized) code into the waiting CLI; false when it can't take one now. */
  submit: (code: string) => boolean
  /** A paste that isn't a code at all: shown like a refused code, and the CLI never sees it. */
  refuse: () => void
  /** "Open again": the person is getting a new code, so an old refusal goes. */
  clearRefusal: () => void
  /** Abandons the run (cancel, sign-out, paste instead); nothing it reports afterwards lands. */
  stop: () => void
}

export function startClaudeSetupRun(args: {
  spawn: SpawnSetupToken
  now: () => number
  isSignInUrl: (url: string) => boolean
  onSetup: (setup: OrcaCloudAgentSetup) => void
  onToken: (token: string) => Promise<void>
  /** The run is over (any outcome); the caller drops its handle. */
  onDone: () => void
}): ClaudeSetupRun {
  const controller = new AbortController()
  let live = true
  let url: string | null = null
  let submitter: SubmitSetupCode | null = null
  // The CLI showed its sign-in link: a run that ends without a token after that has expired.
  let linkShown = false
  // The pasted code's progress; a refusal stays until the next paste or "Open again" (design-squad).
  let code: 'checking' | 'rejected' | null = null
  const startedAt = args.now()
  const browser = (next?: 'checking' | 'rejected' | null): void => {
    if (next !== undefined) {
      code = next
    }
    args.onSetup({
      phase: 'browser',
      startedAt,
      canReopen: url !== null,
      ...(submitter ? { acceptsCode: true } : {}),
      ...(code ? { code } : {})
    })
  }
  browser()
  void runClaudeSetupToken({
    spawn: args.spawn,
    signal: controller.signal,
    onAuthorizeUrl: (link) => {
      if (live && args.isSignInUrl(link)) {
        url = link
        linkShown = true
        browser()
      }
    },
    onAcceptsCode: (submit) => {
      if (live) {
        submitter = submit
        browser()
      }
    },
    onCodeRejected: () => {
      if (live) {
        // The CLI starts over: the old link and its code are spent until the new link shows.
        url = null
        submitter = null
        browser('rejected')
      }
    }
  }).then(async (outcome) => {
    if (!live) {
      return
    }
    live = false
    url = null
    submitter = null
    args.onDone()
    if (outcome.ok) {
      await args.onToken(outcome.token)
      return
    }
    if (outcome.error === 'capture_failed' && linkShown) {
      // The sign-in was underway and the CLI went away: say it expired; "Open again" starts over.
      args.onSetup({ phase: 'failed', error: 'timed_out' })
      return
    }
    switch (outcome.error) {
      case 'cancelled':
        args.onSetup({ phase: 'idle' })
        return
      case 'no_cli':
      case 'capture_failed':
        args.onSetup({ phase: 'paste', reason: outcome.error })
        return
      case 'denied':
      case 'timed_out':
        args.onSetup({ phase: 'failed', error: outcome.error })
    }
  })
  return {
    url: () => (live ? url : null),
    submit: (code) => {
      if (!live || !submitter || !submitter(code)) {
        return false
      }
      browser('checking')
      return true
    },
    refuse: () => {
      if (live && submitter) {
        browser('rejected')
      }
    },
    clearRefusal: () => {
      if (live && code === 'rejected') {
        browser(null)
      }
    },
    stop: () => {
      live = false
      url = null
      submitter = null
      controller.abort()
    }
  }
}
