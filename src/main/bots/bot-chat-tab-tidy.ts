// The tabs of the chats Orca started for bot requests close by themselves once nothing needs them: the
// chat keeps its transcript, draft, address and restart recovery, keeps running if anything comes,
// stays in the bot's Chats and Session History, and opens again from there. A request sent with
// `--chat new` opens a tab no one ever closed, so every finished or failed request stayed in the bot's
// sidebar for good. Only chats carrying the request mark are looked at; a person's own never are.

/** How long a chat sits untouched (no turn, no mail, its tab not focused or reopened) before its tab closes. */
export const BOT_CHAT_TAB_IDLE_MS = 24 * 60 * 60 * 1000
/** Between passes. */
export const BOT_CHAT_TAB_TIDY_EVERY_MS = 60 * 60 * 1000
/** From the first tick to the first pass; also the wait before the next pass while marks remain unread. */
export const BOT_CHAT_TAB_TIDY_SOON_MS = 10 * 60 * 1000
/** Marked chats one pass looks at (one page of the mark table). */
export const BOT_CHAT_TAB_TIDY_MAX_LOOKS = 50
/** Close attempts one pass makes (each asks the window, then writes the hide). */
export const BOT_CHAT_TAB_TIDY_MAX_CLOSES = 40
/** Repairs one pass makes, and how many a hide that went wrong is tried. */
export const BOT_CHAT_TAB_TIDY_MAX_REPAIRS = 20
export const BOT_CHAT_TAB_REPAIR_TRIES = 3
export const BOT_CHAT_TAB_REPAIR_QUEUE_MAX = 100

/** A request chat with one tab in its bot's home, every session of its lineage, and the tab. */
export type BotChatTabCandidate = {
  chatId: string
  botId: string
  workspaceId: string
  lineage: readonly string[]
  tabSessionId: string
  tabId: string
}

/** A chat tab in a bot's home, as one snapshot of the host's tabs lists it. */
export type BotChatTabRow = { sessionId: string; tabId: string; isActive: boolean; isPinned?: true }
/** Each home's tab snapshot, read once per pass. */
export type BotChatTabPassTabs = Map<string, Promise<readonly BotChatTabRow[]>>

export type BotChatTabKeep = { kind: 'keep'; why: string }
export type BotChatTabLocated = BotChatTabKeep | ({ kind: 'candidate' } & BotChatTabCandidate)
/** `check` runs again inside the hide's write and throws when anything changed. */
export type BotChatTabAdmission = BotChatTabKeep | { kind: 'go'; check: () => void }
/** What the host's own records say of the tab after a hide was tried. */
export type BotChatTabState = 'visible' | 'background' | 'unknown'
/** sessionId -> what the restart recovery capsule holds for it; null when it could not be read. */
export type BotChatTabCustody = ReadonlyMap<string, string> | null

export type BotChatTabTidyHost = {
  /** Marked chats after `after`, in id order. */
  page: (after: string, limit: number) => string[]
  /** Record, bot, lineage and the chat's one tab; `tabs` caches each home's tab snapshot for a pass. */
  locate: (chatId: string, tabs: BotChatTabPassTabs) => Promise<BotChatTabLocated>
  /** Activity, holds, items, rest and held input, read now. */
  admit: (candidate: BotChatTabCandidate) => Promise<BotChatTabAdmission>
  custody: () => Promise<BotChatTabCustody>
  /** The window that owns the layout says whether the tab may go; it closes nothing. */
  consent: (candidate: BotChatTabCandidate) => Promise<'consent' | 'kept' | 'error'>
  /** The background hide, keeping restart recovery; may throw, the state is read back after. */
  hide: (candidate: BotChatTabCandidate, check: () => void) => Promise<void>
  state: (candidate: BotChatTabCandidate) => BotChatTabState
  /** The host's tab snapshot still lists the tab after the hide committed. */
  listed: (candidate: BotChatTabCandidate) => Promise<boolean>
  /** Retires a committed hide's leftover snapshot row and saved tab. */
  retireListing: (candidate: BotChatTabCandidate) => Promise<void>
  /** Shows the same chat's tab again (identity-safe: a newer show already there is left as it is). */
  reveal: (candidate: BotChatTabCandidate) => Promise<void>
  changed: (botIds: readonly string[]) => void
  pause: () => Promise<void>
  now: () => number
  warn: (message: string, error: unknown) => void
}

export type BotChatTabTidyPass = {
  closed: string[]
  /** Kept by the window, refused by the write, or handed back: tried again on a later lap. */
  refused: string[]
  /** Hidden, then shown again because something held it once the hide committed. */
  revealed: string[]
  more: boolean
}

type RepairEntry = { candidate: BotChatTabCandidate; tries: number }

const holdsIn = (custody: BotChatTabCustody, lineage: readonly string[]): boolean =>
  custody === null || lineage.some((id) => custody.has(id))

/** One pass: repairs first, then one page of marked chats after `cursor`. */
export async function tidyBotChatTabs(
  host: BotChatTabTidyHost,
  options: {
    cursor: string
    repairs: RepairEntry[]
    stopped?: () => boolean
    budget?: { looks: number; closes: number; repairs: number }
  }
): Promise<BotChatTabTidyPass & { cursor: string }> {
  const budget = {
    ...(options.budget ?? {
      looks: BOT_CHAT_TAB_TIDY_MAX_LOOKS,
      closes: BOT_CHAT_TAB_TIDY_MAX_CLOSES,
      repairs: BOT_CHAT_TAB_TIDY_MAX_REPAIRS
    })
  }
  const pass: BotChatTabTidyPass = { closed: [], refused: [], revealed: [], more: false }
  const changed = new Set<string>()
  const stopped = options.stopped ?? (() => false)
  await runRepairs(host, options.repairs, budget, changed)
  let custody: BotChatTabCustody | undefined
  const custodyNow = async () => (custody ??= await host.custody().catch(() => null))
  const tabs: BotChatTabPassTabs = new Map()
  const pageSize = budget.looks
  const page = host.page(options.cursor, pageSize)
  let cursor = options.cursor
  for (const chatId of page) {
    if (stopped() || budget.closes <= 0) {
      pass.more = true
      break
    }
    budget.looks -= 1
    cursor = chatId
    try {
      await tidyOne(host, chatId, {
        tabs,
        custodyNow,
        budget,
        pass,
        changed,
        repairs: options.repairs
      })
    } catch (error) {
      host.warn('[bots] could not tidy a chat tab', error)
    }
  }
  // A full page means more marks may follow; a short one ends the lap.
  if (!pass.more && pageSize > 0 && page.length >= pageSize) {
    pass.more = true
  }
  if (!pass.more) {
    cursor = ''
  }
  if (changed.size > 0) {
    host.changed([...changed])
  }
  return { ...pass, cursor }
}

type OneState = {
  tabs: BotChatTabPassTabs
  custodyNow: () => Promise<BotChatTabCustody>
  budget: { closes: number }
  pass: BotChatTabTidyPass
  changed: Set<string>
  repairs: RepairEntry[]
}

async function tidyOne(host: BotChatTabTidyHost, chatId: string, state: OneState): Promise<void> {
  const located = await host.locate(chatId, state.tabs)
  if (located.kind === 'keep') {
    return
  }
  const candidate: BotChatTabCandidate = located
  const admission = await host.admit(candidate)
  if (admission.kind === 'keep' || holdsIn(await state.custodyNow(), candidate.lineage)) {
    return
  }
  state.budget.closes -= 1
  const consent = await host.consent(candidate)
  if (consent !== 'consent') {
    state.pass.refused.push(chatId)
    return
  }
  try {
    await host.hide(candidate, admission.check)
  } catch (error) {
    host.warn('[bots] a chat tab hide failed; reading back its state', error)
  }
  await settleHide(host, candidate, state)
  await host.pause()
}

/** After a hide was tried, whatever it returned: the host's own state decides what happened. */
async function settleHide(
  host: BotChatTabTidyHost,
  candidate: BotChatTabCandidate,
  { pass, changed, repairs }: Pick<OneState, 'pass' | 'changed' | 'repairs'>
): Promise<void> {
  const after = host.state(candidate)
  if (after === 'visible') {
    pass.refused.push(candidate.chatId)
    return
  }
  if (after === 'unknown') {
    enqueueRepair(repairs, candidate)
    pass.refused.push(candidate.chatId)
    return
  }
  changed.add(candidate.botId)
  // Committed: the decision is read once more, in full. Anything that arrived meanwhile (an item
  // reopened, mail, a start, a recovery offer, a turn) wins, and the same chat's tab comes back.
  const again = await host
    .admit(candidate)
    .catch((): BotChatTabAdmission => ({ kind: 'keep', why: 'unreadable' }))
  const custody = await host.custody().catch(() => null)
  if (again.kind === 'keep' || holdsIn(custody, candidate.lineage)) {
    try {
      await host.reveal(candidate)
      pass.revealed.push(candidate.chatId)
    } catch (error) {
      host.warn('[bots] could not show a chat tab again', error)
      enqueueRepair(repairs, candidate)
    }
    return
  }
  pass.closed.push(candidate.chatId)
  if (await host.listed(candidate).catch(() => true)) {
    enqueueRepair(repairs, candidate)
  }
}

function enqueueRepair(repairs: RepairEntry[], candidate: BotChatTabCandidate): void {
  if (
    repairs.length < BOT_CHAT_TAB_REPAIR_QUEUE_MAX &&
    !repairs.some((entry) => entry.candidate.tabSessionId === candidate.tabSessionId)
  ) {
    repairs.push({ candidate, tries: 0 })
  }
}

/** Each queued hide that went wrong, by the identity it was tried with: a newer show wins. */
async function runRepairs(
  host: BotChatTabTidyHost,
  repairs: RepairEntry[],
  budget: { repairs: number },
  changed: Set<string>
): Promise<void> {
  for (const entry of repairs.slice()) {
    if (budget.repairs <= 0) {
      return
    }
    budget.repairs -= 1
    entry.tries += 1
    const { candidate } = entry
    const drop = () => repairs.splice(repairs.indexOf(entry), 1)
    try {
      const now = host.state(candidate)
      if (now === 'visible') {
        drop()
        continue
      }
      if (now === 'background') {
        const again = await host.admit(candidate)
        const custody = await host.custody().catch(() => null)
        if (again.kind === 'keep' || holdsIn(custody, candidate.lineage)) {
          await host.reveal(candidate)
        } else if (await host.listed(candidate)) {
          await host.retireListing(candidate)
        }
        changed.add(candidate.botId)
        drop()
        continue
      }
    } catch (error) {
      host.warn('[bots] a chat tab repair failed', error)
    }
    if (entry.tries >= BOT_CHAT_TAB_REPAIR_TRIES) {
      drop()
    }
  }
}

/** Runs a pass when one is due; never two at once; the pass holds everything it started until it
 *  settles. The first pass comes a while after launch; while marks remain unread, the next comes sooner. */
export class BotChatTabTidyTicker {
  private firstTickAt: number | null = null
  private nextAt: number | null = null
  private running: Promise<BotChatTabTidyPass> | null = null
  private cursor = ''
  private readonly repairs: RepairEntry[] = []
  private stopped = false

  constructor(private readonly host: () => BotChatTabTidyHost) {}

  /** Later ticks do nothing; a running pass stops before its next chat. */
  stop(): Promise<void> {
    this.stopped = true
    return this.running ? this.running.then(() => undefined) : Promise.resolve()
  }

  tick(now: number): Promise<BotChatTabTidyPass> {
    this.firstTickAt ??= now
    const nextAt = this.nextAt ?? this.firstTickAt + BOT_CHAT_TAB_TIDY_SOON_MS
    if (this.stopped || this.running || now < nextAt) {
      return Promise.resolve({ closed: [], refused: [], revealed: [], more: false })
    }
    this.nextAt = now + BOT_CHAT_TAB_TIDY_EVERY_MS
    const run = tidyBotChatTabs(this.host(), {
      cursor: this.cursor,
      repairs: this.repairs,
      stopped: () => this.stopped
    })
      .then(({ cursor, ...pass }) => {
        this.cursor = cursor
        if (pass.more || this.repairs.length > 0) {
          this.nextAt = now + BOT_CHAT_TAB_TIDY_SOON_MS
        }
        return pass
      })
      .finally(() => {
        this.running = null
      })
    this.running = run
    return run
  }
}
