export type PendingAccountLoginProvider = 'codex' | 'claude'
export type PendingAccountLoginStatus = 'in_progress' | 'completed' | 'failed'

export type PendingAccountLoginSnapshot<TState> = {
  loginId: string
  provider: PendingAccountLoginProvider
  status: PendingAccountLoginStatus
  outputTail: string
  state?: TState
  error?: string
}

const OUTPUT_TAIL_MAX_CHARS = 4_000
// Why: reclaim a finished login even if the CLI process that started it never
// polls again (crash, Ctrl-C) — a long-lived `orca serve` must not accumulate
// one entry per headless add-account attempt forever.
const TERMINAL_ENTRY_TTL_MS = 5 * 60 * 1000

type Entry<TState> = {
  snapshot: PendingAccountLoginSnapshot<TState>
  listeners: Set<() => void>
  inputWriter: ((text: string) => void) | null
}

/** Tracks headless `accounts.add*` logins between the fire-and-forget kickoff
 *  call and the long-poll `accounts.pollAdd` calls that follow it. Shared
 *  across providers because the CLI polls a single loginId without knowing
 *  which provider issued it. */
export class PendingAccountLoginRegistry<TState> {
  private readonly entries = new Map<string, Entry<TState>>()

  begin(loginId: string, provider: PendingAccountLoginProvider): void {
    this.entries.set(loginId, {
      snapshot: { loginId, provider, status: 'in_progress', outputTail: '' },
      listeners: new Set(),
      inputWriter: null
    })
  }

  appendOutput(loginId: string, chunk: string): void {
    const entry = this.entries.get(loginId)
    if (!entry || entry.snapshot.status !== 'in_progress') {
      return
    }
    const combined = `${entry.snapshot.outputTail}${chunk}`
    entry.snapshot = {
      ...entry.snapshot,
      outputTail:
        combined.length > OUTPUT_TAIL_MAX_CHARS ? combined.slice(-OUTPUT_TAIL_MAX_CHARS) : combined
    }
    this.notify(entry)
  }

  complete(loginId: string, state: TState): void {
    this.settle(loginId, { status: 'completed', state })
  }

  fail(loginId: string, error: string): void {
    this.settle(loginId, { status: 'failed', error })
  }

  get(loginId: string): PendingAccountLoginSnapshot<TState> | undefined {
    return this.entries.get(loginId)?.snapshot
  }

  // Why: called once the login child process is spawned (see Claude's
  // `onChildReady`), so a later `submitInput` call has somewhere to write the
  // pasted code. A no-op once the login has already settled — there is no
  // live process left to write to.
  setInputWriter(loginId: string, writeInput: (text: string) => void): void {
    const entry = this.entries.get(loginId)
    if (!entry || entry.snapshot.status !== 'in_progress') {
      return
    }
    entry.inputWriter = writeInput
  }

  // Why: relays text the CLI read from the user's terminal into the login
  // child process's stdin on the server — the other half of the headless
  // Claude paste-back flow.
  submitInput(loginId: string, text: string): void {
    const entry = this.entries.get(loginId)
    if (!entry || entry.snapshot.status !== 'in_progress') {
      throw new Error('That account login no longer exists.')
    }
    if (!entry.inputWriter) {
      throw new Error('This login is not waiting for input.')
    }
    entry.inputWriter(text)
  }

  // Why: mirrors OrcaRuntimeService#waitForMessage — resolves on the next
  // update or timeout and never rejects, so a long-poll caller always gets a
  // response to hand back to the CLI's poll loop.
  waitForUpdate(loginId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const entry = this.entries.get(loginId)
    if (!entry || entry.snapshot.status !== 'in_progress') {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const settleWait = (): void => {
        clearTimeout(timeout)
        entry.listeners.delete(settleWait)
        signal?.removeEventListener('abort', settleWait)
        resolve()
      }
      const timeout = setTimeout(settleWait, timeoutMs)
      entry.listeners.add(settleWait)
      if (signal) {
        if (signal.aborted) {
          settleWait()
          return
        }
        signal.addEventListener('abort', settleWait, { once: true })
      }
    })
  }

  private settle(
    loginId: string,
    patch: { status: 'completed'; state: TState } | { status: 'failed'; error: string }
  ): void {
    const entry = this.entries.get(loginId)
    if (!entry || entry.snapshot.status !== 'in_progress') {
      return
    }
    entry.snapshot = { ...entry.snapshot, ...patch }
    // Why: a settled login has no live child process; drop the writer so a
    // stray late submitInput fails with a clear error instead of writing to a
    // dead stream.
    entry.inputWriter = null
    const ttlTimeout = setTimeout(() => this.entries.delete(loginId), TERMINAL_ENTRY_TTL_MS)
    ttlTimeout.unref()
    this.notify(entry)
  }

  private notify(entry: Entry<TState>): void {
    const listeners = [...entry.listeners]
    entry.listeners.clear()
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        // Why: this runs inside a child-process 'data'/'close' handler via
        // appendOutput/settle. One waiter throwing must not stop the rest of
        // a fan-out (e.g. two concurrent pollAdd calls on the same loginId)
        // from being released, or the whole host process from staying up.
        console.warn('[pending-account-login-registry] Listener threw during notify:', error)
      }
    }
  }
}
