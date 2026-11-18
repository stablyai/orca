/** Bumped only for a breaking change; within a version, fields and capabilities are only added. */
export const CONNECTOR_CONTRACT_VERSION = 1

// How long work waits for a machine that is asleep or offline: a person's start or send, and an
// automation's trigger at its longest grace. The same day for both.
const MACHINE_WAIT_MS = 24 * 60 * 60 * 1000

export const CONNECTOR_LIMITS = {
  initialPollHoldMs: 50_000,
  // The machine abandons a held poll after this; the cloud holds below it and below the token expiry.
  pollTimeoutMs: 70_000,
  maxDeliveriesPerPoll: 20,
  // A poll stops adding deliveries past this many bytes (one always goes), well under Cloud Run's
  // 32 MiB response cap: a bot's start or send carries its words twice, labelled and not.
  maxPollDeliveryBytes: 8 * 1024 * 1024,
  // An answer or cancel; a person's start or send waits requestWaitMs.
  deliveryTtlMs: 5 * 60 * 1000,
  // A person's start or send waits this long for its machine, then expires unreached.
  requestWaitMs: MACHINE_WAIT_MS,
  // A handed-out delivery not yet received goes out again, same id, after this.
  leaseMs: 30_000,
  // A leased delivery that was never received expires this long after expiresAt.
  leasedExpiryGraceMs: 30_000,
  // The machine refuses a delivery with less than this left before its deadline.
  minDeadlineLeftMs: 10_000,
  maxLastAssistantMessageBytes: 8 * 1024,
  // The admitted deliveries one reply event settles; a longer group goes as several events.
  maxReplyDeliveryIds: 100,
  // A prompt's text for a card that links to Orca (its header, questions and option labels).
  maxPromptTextBytes: 1500,
  // Who woke the turn that raised a prompt, by name.
  maxPromptWokenByChars: 64,
  // The option labels a prompt answered in Orca chose.
  maxPromptAnsweredWithChars: 80,
  // An owner's reply that answers a free-text question.
  maxAnswerTextChars: 4000,
  // The cloud refuses a larger request body with 413. Sized for a hello of maxHelloBots bots at every
  // cap (about 700 KB); machines may keep their own requests smaller.
  maxRequestBytes: 1024 * 1024,
  // One event's JSON, so any single event fits in an events request.
  maxEventBytes: 192 * 1024,
  // A snapshot lists linked conversations active in the last 7 days, newest first, up to this many.
  maxSnapshotConversations: 200,
  snapshotActiveWindowMs: 7 * 24 * 60 * 60 * 1000,
  maxDisplayTextLength: 200,
  // A turn end's pull request links.
  maxWorkLinks: 5,
  // Bots one hello lists, and one bot page. A machine with more sends them in pages first.
  maxHelloBots: 20,
  // A machine's bots beyond one hello: up to this many pages of maxHelloBots, listed by its hello.
  maxBotPages: 100,
  // A staged page its hello never took is dropped after this.
  botPageTtlMs: 10 * 60 * 1000,
  maxBotIdLength: 128,
  maxBotMembers: 200,
  // Linear user ids are UUIDs, longer than the Slack ids `members` was sized for; GitHub's are
  // numbers. With these caps a hello of maxHelloBots bots still fits maxRequestBytes.
  maxBotWorkspaceMemberIdLength: 64,
  maxBotWorkspaceMembers: 50,
  maxBotHandleLength: 64,
  // A reply's inline review notes: with every one at its cap, all of them still fit in one GitHub
  // comment (where GitHub takes no review) beside the start of the text.
  maxReviewComments: 30,
  maxReviewPathLength: 256,
  maxReviewCommentChars: 1_000,
  // One per Linear workspace or GitHub installation, each with its own maxBotWorkspaceMembers.
  maxBotWorkspaces: 8,
  // Slack's rows, beside those: one per workspace the bot's app is in, together holding at most
  // maxBotMembers people (the bot's one Slack list, split by workspace).
  maxBotSlackWorkspaces: 8,
  // Event rules of a machine's bot automations (five automations at their 20 each); at every cap
  // they add under 250 KB to a hello.
  maxHelloTriggers: 100,
  maxTriggerPlaces: 10,
  // An event's quoted text, and how much of it a text filter reads.
  maxTriggerTextLength: 4096,
  // A trigger delivery waits for its machine for the automation's grace, never longer than this.
  maxTriggerWaitMs: MACHINE_WAIT_MS,
  // A bot's automations one message it is asked can also match, carried in its turn.
  maxTurnAutomations: 10,
  // A bare mention's request (asker.earlierOwn): the asker's newest messages before it, each's text
  // and files capped; what doesn't fit is marked as not carried.
  maxEarlierOwnMessages: 10,
  maxEarlierOwnText: 4000,
  maxEarlierOwnFiles: 10,
  // Orca's note on where a bot was asked (asker.note).
  maxAskerNoteLength: 4000
} as const
