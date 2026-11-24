# Slack thread reply preference

This repository provides the bot setting, desktop/mobile controls, owner-only update handling,
and connector hello contract. The hosted connector service is maintained outside this repository.
Live mention-only routing requires that service to implement the behavior below.

## Wire contract

The cloud advertises `slack.threadReplies` in its hello response **only after implementing it**.
The exported `CONNECTOR_CLOUD_SLACK_THREAD_REPLIES_FEATURE` constant is deliberately outside
`CONNECTOR_CLOUD_FEATURES`, so importing a new contract does not advertise unimplemented behavior.

After negotiation, each hello bot (including staged bot pages) contains:

```json
{ "id": "bot-id", "slackThreadReplies": "mentions" }
```

`always` is the other value. Hosts list the machine feature `slackThreadReplies` in every hello.
For such a host, an absent field during negotiation preserves the cloud's existing choice (a new
bot defaults to `always`). A supporting host sends `always` explicitly when the choice is unset or switched off, so a
previous cloud-side `mentions` value is cleared. Hosts omit the field before negotiation and when
the cloud does not advertise support. A preference saved locally survives that omission.
Hosts without the machine feature are older builds: an omitted field resets to `always`.

`bots.update` accepts the same field from the owner. Enabling `mentions` requires the host's
current cloud to advertise support. The host annotates `bots.slack.state` with the optional
`slackThreadRepliesSupported` boolean; clients treat absent/false as unavailable. This annotation
comes from the bot's execution host, including paired remote hosts, rather than the viewing client.
The phone also requires `bots.slack-thread-replies.v1` from its host before offering writes.

## Required hosted-service behavior

1. Store the preference with each account/host's bot inventory, including bot pages. With machine
   feature `slackThreadReplies`, an omitted field preserves its existing preference until the
   negotiated hello sends it explicitly. Do not briefly reset a reconnecting bot to `always`
   during the first hello; Slack events can arrive between the two hellos. For older hosts without
   that machine feature, reset to `always` when their hello omits the field.
2. For ordinary conversational replies in public/private **channel threads**, decide using the
   original Slack message and that installed app's `botUserId`, before stripping/resolving mentions.
   With `mentions`, messages without a direct mention of this bot must not create a `start` or
   `send` delivery, even when the thread already belongs to the bot or its chat was deleted.
   Mentions of a person or another app do not count. Bare mentions still wake the bot.
3. Make that decision before creating work/status posts, acknowledgements, reactions, answer
   choices by reply, or a batch of conversational sends. A skipped message must cause no agent turn
   and no Slack post. Deduplicate Slack `app_mention` and `message` events as usual. Apply changes
   to queued conversational messages before delivery, without replaying old skipped messages as
   new requests when the preference changes.
4. Direct messages retain their existing routing regardless of the setting. Existing authorization,
   paused-bot rules, explicit answer-button deliveries, Stop, Resume, and independently configured
   automations retain their existing rules. The preference controls conversational thread replies,
   not the permissions or schedules of separate automations.
5. Keep skipped messages available to the bot's next mentioned turn as **context**, never as new
   requests. Include them in `asker.context` catch-up where possible (`threadCatchUp`), with the
   existing `more`/access markers when bounded. Do not advance the thread's delivered-context
   cursor past skipped messages. Preserve the existing `read` action for the thread ref so
   `orca slack read slack:TEAM:CHANNEL:THREAD --limit 100` can fetch context on demand.
6. Advertise `slack.threadReplies` only once routing, quiet skipping, DM handling and context
   access are deployed. Verify both old/default bots and bots switching in both directions.

There is no desktop text-based filter or per-delivery read round trip. Filtering by `NO_REPLY`
would still start an agent turn and cannot recover the missing mention information.

## Read-only evidence (2026-11-25)

The installed bot's `botUserId` was read using `bots.slack.state`. A saved user journal item was
matched to the same Slack message via `asker.messageRef`, and `connector.act` with `verb: read`
read the original thread. IDs and unrelated words are abbreviated below:

```text
messageRef: slack:TEAM:CHANNEL:1795536860.914739:1795537024.771699
Slack original: <@BOT> 너랑 <@OTHER> …동작 방식 차이가…?
delivered request text: 너랑 <@OTHER|display name> …동작 방식 차이가…?
```

This is a reply inside an existing channel thread, not its opening message. The bot's own mention
was absent in the delivered request; a different app's mention remained. Other app-authored
messages retained this bot's mention, so absence is ambiguous rather than a reliable negative.
The journal stores the rendered request, not the raw delivery JSON; the request builder reads
`asker.text` without removing bot mentions. No raw delivery capture was available. The existing
thread read returned messages around this reference, confirming a context-read path exists, but
future skipped-message catch-up remains a hosted-service acceptance requirement.

## Handoff to the Orca connector team

Implement the optional hello bot field `slackThreadReplies: 'always' | 'mentions'`. With machine
feature `slackThreadReplies`, a missing field during negotiation preserves the stored choice;
older hosts without that feature default to `always`. In `mentions` mode, suppress conversational routing of unmentioned channel-thread
messages before any delivery/status output, using raw Slack mentions and the installed bot's ID.
Keep DMs unchanged and skipped posts readable as context on the next mention. Advertise
`slack.threadReplies` only after that behavior is deployed. Desktop and mobile controls stay
unavailable against clouds that do not advertise it.
