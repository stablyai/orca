// Which saved account an `agy acp` on this host launched on. Saved accounts swap agy's one login
// inside one home, so the home can't tell; the selected saved account names it. A chat that
// launched on another account moves to the selected one at its next send.

type SelectionChangedListener = (committed: () => boolean) => void
type Vault = {
  selectedAccountId: string | null
  accounts: readonly { id: string; email: string | null }[]
}
type Process = { onExit(listener: () => void): void }
/** Where a launch's preparation left agy's login: on `key`, prepared for `target`; `failure` says
 *  why they differ. */
export type AgyPreparedLogin = { key: string; target: string; failure?: string }
export type AgyChatNotMoved = { sessionId: string; to: string; reason: string }

/** No saved account selected: agy runs on whatever login it holds. */
const NONE = ''

export class AgyAccountSelection {
  /** Undefined until the host's vault was first read. */
  private selected: string | null | undefined
  private revision = 0
  private emails = new Map<string, string>()
  private readVault: (() => Promise<unknown>) | null = null
  private readonly listeners = new Set<SelectionChangedListener>()
  private readonly processes = new Map<Process, string>()
  private readonly oldLoginsGone = new Set<() => void>()
  private readonly notMoved = new Set<(chat: AgyChatNotMoved) => void>()
  // The selection the latest preparation failed to put agy's login on, until one reaches it or
  // another is selected: relaunching a chat for it would only fail again.
  private stuck: string | null = null

  /** How the selection is read before anything noted it. */
  readWith(read: () => Promise<unknown>): void {
    this.readVault = read
  }

  /** The vault as the host's account service last read or wrote it. */
  note(vault: Vault): void {
    this.emails = new Map(
      vault.accounts.flatMap((account) => (account.email ? [[account.id, account.email]] : []))
    )
    const before = this.selected
    this.selected = vault.selectedAccountId
    if (before !== undefined && before !== vault.selectedAccountId) {
      this.stuck = null
      this.revision += 1
      this.notify()
    }
  }

  /** What a start records: the account it launches on. */
  readonly atLaunch = async (): Promise<string> => {
    if (this.selected === undefined) {
      await this.readVault?.().catch(() => undefined)
    }
    return this.selected ?? NONE
  }

  /** What a running child should match; null until the selection is known. */
  readonly current = (): string | null =>
    this.selected === undefined ? null : (this.selected ?? NONE)

  /** What a running child should match: the selection, or null while moving to it is known to
   *  fail. In memory only, so a send's check does no IO. */
  readonly target = (): string | null => {
    const current = this.current()
    return current !== null && current === this.stuck ? null : current
  }

  /** A failed preparation stops chats moving to its selection; the next evidence that agy's login
   *  holds it (a launch, listing, exit-time restore or the switch itself) lets them move again,
   *  each at its next send. */
  prepared(login: AgyPreparedLogin): void {
    if (login.failure !== undefined) {
      this.stuck = login.target
    } else if (this.stuck !== null && login.key === this.stuck) {
      this.stuck = null
      this.revision += 1
      this.notify()
    }
  }

  /** The saved account's email, when it has one. */
  email(key: string): string | null {
    return this.emails.get(key) ?? null
  }

  /** Listeners hear each new selection with `committed`, false once a later one replaced it. */
  onChanged(listener: SelectionChangedListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** An agy process Orca started now, on the selected account until `spawned` says otherwise. */
  readonly started = (process: Process): void => {
    this.processes.set(process, this.current() ?? NONE)
    process.onExit(() => {
      const key = this.processes.get(process)
      this.processes.delete(process)
      if (key !== undefined && key !== this.current() && !this.otherAccountRunning()) {
        this.oldLoginsGone.forEach((listener) => listener())
      }
    })
  }

  /** A chat's agy spawned on `key`; one whose preparation failed says so in that chat. */
  readonly spawned = (
    process: Process,
    chat: { sessionId: string; key?: string; prepared?: AgyPreparedLogin }
  ): void => {
    // One on a login no saved account names (another home or store, a key) writes none of theirs back.
    if (chat.key === undefined) {
      this.processes.delete(process)
    } else if (this.processes.has(process)) {
      this.processes.set(process, chat.key)
    }
    const { prepared } = chat
    if (prepared?.failure !== undefined) {
      const notMoved = { sessionId: chat.sessionId, to: prepared.target, reason: prepared.failure }
      this.notMoved.forEach((listener) => listener(notMoved))
    }
  }

  /** Hears each chat that started on another account than the selected one it was prepared for. */
  onChatNotMoved(listener: (chat: AgyChatNotMoved) => void): () => void {
    this.notMoved.add(listener)
    return () => {
      this.notMoved.delete(listener)
    }
  }

  /** The last agy Orca started on an account other than the selected one exited: one that
   *  refreshed its token may have written its login back over the selected account's. */
  onOldLoginsGone(listener: () => void): () => void {
    this.oldLoginsGone.add(listener)
    return () => {
      this.oldLoginsGone.delete(listener)
    }
  }

  private otherAccountRunning(): boolean {
    const current = this.current()
    return [...this.processes.values()].some((key) => key !== current)
  }

  private notify(): void {
    const revision = this.revision
    const committed = (): boolean => this.revision === revision
    for (const listener of this.listeners) {
      try {
        listener(committed)
      } catch (error) {
        console.warn('[antigravity] a listener for the selected account failed:', error)
      }
    }
  }
}

/** The host's own agy, which chats on agy's home and on Orca's homes share. */
export const AGY_HOST_SELECTION = new AgyAccountSelection()
