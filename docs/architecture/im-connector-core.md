# IM connector core

## Goal

Orca runs some IM connectors on the bot's own host, with no Orca Cloud between: Feishu, DingTalk and WeCom. Each one streams a reply into the IM while its turn runs, then delivers the answer. `src/main/im-stream/` holds the streaming and delivery code they share, and a few seam pieces hold the plumbing every local connector needs. Neither names an IM.

The three connectors land in their own changes on top of the core; the tables below describe them as ported. Each platform keeps its transport, admission, inbox, card format and copy. The core takes in a chat's journal and a platform's port. It gives back a turn's view, a rendered frame, throttled edits and ordered parts.

## Boundary

The core owns:

- **Reading a turn.** `ImTurnView` comes from the chat's journal, never a transcript file. It holds the phase, the newest thought, the tool steps and the answer so far.
- **Masking.** Thinking and tool input lose key shapes, assignment values and URL userinfo (`maskImText`). An answer keeps its prose and loses only key shapes (`imAnswerText`). A final answer is masked the same way, so it shows no key its progress hid.
- **Step summaries.** `imStep` turns a tool call into a name, a one-line detail and a summary. The input is masked before it is clipped, and a detail that looked secret is dropped.
- **Progress.** `imProgress` gives the structured parts, for a card that lays them out itself. `renderImProgress` gives plain text from a platform's `ImProgressFormat`.
- **Live edits.** `ImLiveStream` writes at most one frame per gap and never two at once, and only the newest waiting frame goes. It degrades once, to `permission`, `rate_limited`, `expired` or `failed`, as the platform's `classify` says, and then writes nothing more.
- **Splitting.** `splitImText` cuts within `{ maxBytes }` or `{ maxChars }`. It never cuts inside a surrogate pair, closes and reopens a code fence across parts, and adds the platform's part labels.
- **Ordered delivery.** `sendImParts` sends parts under one of the two delivery guarantees below.
- **A per-turn reply record.** `ImReplyStream` is for a platform that keeps one record per turn. It opens a card, follows progress and finishes the answer across restarts.

The core does not own the transport (`lark-cli`, `dws`, the WeCom socket), pairing and admission, inbox dedupe, the persistent store, the card JSON, the copy's language, or the review UI.

## Following a turn

All three followers sit on `followImJournal`. It reads after each journal publication, one read at a time and at most one per gap, so a streamed token never costs a read of its own. Each follower moves on to the turn that a mid-turn message reopened, and none stops at the first turn. The platforms need three followers because each seam tells them a different fact:

- **`watchImDeliveryTurns(journal, sessionId, account, onTurn)`** reads the chat's newest turn and the deliveries it took. The deliveries come in the order the reply outbox credits them, so the head owns the reply. It is for an IM whose seam never returns a delivery's own send id. Feishu uses it.
- **`readImTurnView(reads, messageId)` under `followImJournal`** is for an IM that knows the client message id of its send. WeCom uses it.
- **`watchImTurn(journal, sessionId, at, onView)`** pins the root turn recorded after `at`. It is for an IM whose seam reports that a turn started, but not which send opened it. DingTalk uses it.

## Delivery guarantees

A platform names what a resend of the same part does. The core does not treat every platform as exactly once.

- **`exactly-once`.** The platform takes a resend under the same key as the same message, through an idempotency key or an edit of the same card. When a part's outcome is unknown, it goes again.
- **`at-most-once`.** A resend may show twice. When a part's outcome is unknown, it never goes again. It settles as unconfirmed and comes back to the platform, which offers the owner a manual resend. The port's `unknown(error)` separates a failure that surely did not show from one that may have. A part that surely did not show is retried on the next attempt.

`sendImParts` writes each step down before it acts: the part about to go (`partSending`), how many parts settled (`partsSent`), and the parts left unconfirmed (`unconfirmed`). A restart resumes from that record. A part that was in flight when the process stopped goes again under `exactly-once`. Under `at-most-once` it settles as unconfirmed. A card edit replaces the card's content, so repeating the final edit is safe under both guarantees.

| IM       | Guarantee    | Why                                                                                                                                                                                                                                     |
| -------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feishu   | exactly once | Each reply carries a uuid (`final`, `cont-N`), and Feishu answers a repeat within the hour with the message it already sent. The connector stops sending 55 minutes after a reply's first post, and the reply then asks for review.     |
| DingTalk | exactly once | Each part's `dws` uuid derives from its key. Opening a card has no key; see Follow-ups.                                                                                                                                                 |
| WeCom    | at most once | Part 1 goes in the stream's last frame while WeCom still takes edits, and the same stream id edits the same message. Pushed parts have no dedupe key. A push WeCom may have shown is marked unconfirmed and offered as a manual Resend. |

## How each platform plugs in

|                           | Feishu                                          | DingTalk                               | WeCom                                            |
| ------------------------- | ----------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| Answer source             | reply outbox                                    | its own ledger, at the seam's turn end | reply outbox                                     |
| Turn follower             | `watchImDeliveryTurns`                          | `watchImTurn`                          | `readImTurnView`                                 |
| Live message              | `ImLiveStream` over its card, from `imProgress` | `ImReplyStream` over a `dws` card      | `ImLiveStream` over a stream message             |
| Final answer              | its own loop: card, then `splitImText` parts    | `ImReplyStream.finish`                 | `sendImParts`, part 1 as the stream's last frame |
| Limit                     | `{ maxBytes: 20480 }`                           | `{ maxChars: 3500 }`                   | `{ maxBytes: 20480 }`                            |
| Copy                      | English, in the card                            | Chinese, `DINGTALK_REPLY_COPY`         | Chinese, `wecom-copy`                            |
| `LOCAL_CONNECTOR_SOURCES` | yes                                             | no                                     | yes                                              |

Feishu needs neither `ImReplyStream` nor `sendImParts`. Its inbox already records each delivery's card and progress, and several deliveries can share one turn, each with a card saying which reply answers it. DingTalk keeps one record per turn, which is what `ImReplyStream` is for.

## Shared seam pieces

These live outside `im-stream`, because they touch the external-conversation seam and the runtime:

- `LOCAL_CONNECTOR_SOURCES` lists the sources a connector on this host speaks for. A listed source answers through the reply outbox (`answersThroughOutbox`), and its conversations count as the paired owner's own when a reply fills, as a Slack DM's do. A connector that keeps its own ledger, as DingTalk does, stays off the list.
- `ConnectorMessage.storedImages` carries images a connector already saved to the attachment store. They are sent instead of the asker's.
- `ConnectorMessage.transportSignal` carries the connector's lifetime. A start or delivery still waiting when it ends is refused. `startBotChat` holds that check and the bot-agent check for every connector.
- `runtime.localConnectors` (`LocalConnectorHosts`) holds each connector host. It tells the hosts when outbox rows fill and when the account resets, and stops them all on shutdown. An RPC finds its host with `find(HostClass)`.
- Cloud-only paths guard on `cloudConversation(key)`: a bot's thread reply and a thread leave. A local source in the union never reaches cloud serialization.

## Adding an IM

1. Add the source to `CONNECTOR_SOURCES` and `CONNECTOR_SOURCE_NAMES`. Add it to `LOCAL_CONNECTOR_SOURCES` if it answers through the outbox and only its paired owner asks.
2. Write a host with `stop()`, plus `repliesFilled()` and `rewatch()` if it uses the outbox. Register it with `runtime.localConnectors.add(host)`.
3. Own the transport, admission and inbox dedupe. Hand each admitted message to `ExternalConversationSeam.start` or `deliverToChat`, with `transportSignal` and any `storedImages`.
4. Pick the turn follower that matches what the seam tells the IM.
5. Write the platform's copy (`ImReplyCopy` or `ImProgressFormat`), or a card built from `imProgress`.
6. Write the port: `open`, `update` and `send`, its `guarantee`, `unknown` if it is at most once, and a `classify` for edit errors. Then use `ImReplyStream`, or `ImLiveStream` and `sendImParts` directly.
7. Set the text limit in bytes or characters, and mask the final answer with `imAnswerText`.

## Module map

- `im-stream-follow.ts` reads a chat's journal as it publishes (`ImJournal`, `followImJournal`).
- `im-stream-turn-view.ts`, `im-stream-turn-watch.ts` and `im-stream-delivery-turn.ts` hold the turn view and the three followers.
- `im-stream-mask.ts` and `im-stream-step.ts` hold masking and step summaries.
- `im-stream-progress.ts` holds structured and plain-text progress.
- `im-stream-throttle.ts` and `im-stream-live.ts` hold paced edits and degrading.
- `im-stream-parts.ts` holds splitting and part labels.
- `im-stream-part-delivery.ts` holds the delivery guarantees (`sendImParts`).
- `im-stream-reply.ts` holds the per-turn reply record (`ImReplyStream`).
- `src/main/local-connectors/local-connector-hosts.ts` holds the runtime registry.

## Alternatives rejected

- **A connector base class that owns transport, inbox and pairing.** These differ on every platform. Feishu drives `lark-cli`, DingTalk drives `dws`, and WeCom keeps a socket. Feishu pairs a verified DM, DingTalk reads its group setup, and WeCom takes a pairing code. A base class would hold three branches of platform code.
- **Everything exactly once.** WeCom pushes have no key, so resending an unknown push could show it twice. The core names the guarantee instead.
- **Feishu on `ImReplyStream`.** Its inbox already records card progress per delivery, and its joined-delivery cards need state per message. Moving it would rewrite tested code for nothing the core adds.

## Follow-ups

These were left out because only one platform has them, or because merging them is not yet simpler:

- **The SQLite inbox and its dedupe.** Feishu and WeCom both keep one, with different schemas and reply states. DingTalk keeps a JSON ledger. Merging them is a migration.
- **Pairing and admission:** Feishu's verified DM, WeCom's pairing code and DingTalk's group setup.
- **Review UI:** the Only-in-Orca item; Needs a look, Retry, Dismiss and Resend; and the connector catalogue entries.
- **A shared Resend.** Once a second IM is at most once, WeCom's Resend for unconfirmed parts can move into shared UI and RPC.
- **DingTalk on the outbox.** It would then join `LOCAL_CONNECTOR_SOURCES` and drop its own turn-end attribution.
- **DingTalk's runtime field.** It still has `runtime.dingtalkLocal` for its RPC. Its connector comes from a factory, so `find(HostClass)` has no class to match.
- **DingTalk's card open.** It has no dedupe key. If a restart lands between asking for the card and recording it, a placeholder card may be left behind (the record says `opening`), and the answer goes as messages.

## Verification

`im-stream.test.ts` covers the invariants that cost the most to break:

- throttle pacing and close ordering, and degrading;
- masking of thinking, tool input and answers;
- lossless, fence-closing splits;
- following a restarted turn and every turn of a chat;
- both guarantees across a lost send and a restart;
- the card fallback, and a card that refuses the final edit.

Each platform keeps its own tests for its port, inbox and outbox.
