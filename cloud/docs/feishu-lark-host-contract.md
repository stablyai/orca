# Feishu and Lark: provisional host contract

Public host slice for [#45103](https://github.com/stablyai/orca/issues/45103).
This is not a deployed connector or an app-registration API. The hosted connector
service lives in the private `stablyai/orca-cloud` repository. No credentials,
callback listener, setup screen, or production configuration are added here.

## Negotiation

The only proposed wire additions are conversation sources `feishu` (China) and
`lark` (international), and the corresponding hello-response features
`feishu.mentions` and `lark.mentions`. These names are **provisional**, pending
Cloud review. The adapter must advertise each feature explicitly; neither is in
the default Cloud feature list. Supporting one does not enable the other.

A host's first hello lists its existing sources. After Cloud advertises a new
source's feature **and** `replies.outbox`, the host sends another hello including
that source, using the existing hello revision protocol. Cloud must deliver it only under a hello that
lists that source. An older Cloud that omits the features sees the existing source
list and existing Bot records. No new Bot configuration or authentication fields
are sent. Future setup UI must also require the corresponding Cloud capability.

New-source admission requires `replies.outbox`, so its answer remains durable
when the Cloud loses source support. Snapshots and transient events omit
unsupported new-source conversations. Filled replies remain in the journal
until support returns; terminal turn events wait in the durable event outbox
**within its existing shared 200-event cap**. Supported events may pass held
events, and explicit unsupported replies are refused locally. Slack can still publish its
snapshot to an older Cloud. Existing replies may use the legacy reply route when
the source remains supported but the outbox feature is disabled.

The turn-event cap is shared across sources. Overflow from either additional held
events or supported-source traffic can evict older held turn ends before support
returns. A later snapshot restates current state, not the discarded historical
completion metadata. This is bounded progress/state replay, not a lossless event
archive. The cap does **not** remove pending reply-journal rows; final answer
retention is independent. A lossless lifecycle-replay requirement would need a
separate retention/backpressure design outside this slice.

The capability means group mentions and replies are actually available, with
hosted installation binding, access checks, durable delivery and reply support.
It must not be advertised merely because the schema accepts the new source.
DMs, unmentioned thread continuation, source action verbs and attachments are not
promised by this capability.

## Reused interface

All routes, versions and fields below already exist. The public host treats the
conversation key as opaque and never derives app credentials or tenant membership
from it.

| Exchange | Existing fields and required semantics |
| --- | --- |
| Host hello | `sources`, `bots[].id`, `bots[].agent`, `bots[].paused`; Cloud binds an installation to one selected, available host Bot. |
| Cloud poll | `kind: "start"`, unique `deliveryId`, `seq`, `expiresAt`, `agent`, `placeId`, `prompt`, `asker`, `conversation`. `placeId` is base64url JSON `["bot", botId]`. |
| Conversation | `{source: "feishu" \| "lark", externalId: opaqueString}`. Cloud must assign different keys across platform, installation/app, tenant, chat, root thread and selected Bot bindings. Keep the key stable for follow-ups. |
| Requester | `asker.userId` is an installation-scoped platform identity whose access Cloud already checked; `role` is `owner` or `member`, never inferred from display name. Use `place.kind: "channel"` and the chat ID for the initial group-mention slice. `group_message` currently means group DM in Orca. |
| Admission | Existing received/done acknowledgements. With `replies.outbox`, received follows journal admission. Public receipts deduplicate a repeated delivery for the same conversation; Cloud still owns event/message-ID deduplication before delivery. |
| Reply | Existing `reply` events with `conversation`, `deliveryIds`, `answerDeliveryId`, `outcome`, `prose`; or existing `/replies` with `replyId`, `conversation`, `turnId`, `text`. Cloud resolves the original installation and thread from the stored conversation, never from agent-provided text. |
| Progress | Existing linked/turn-started/turn-ended events; optional activity requires its existing `turn.activity` capability. |

`deliveryId` must be unique across sources/installations **within the Orca account**,
not just a raw Feishu message ID: acknowledgement tracking and reply-journal keys
already rely on this. The host's conversation/receipt keys include both `source`
and the entire `externalId`. Tests use readable synthetic IDs such as
`cli_app_a:tenant_a:oc_reviews:om_root`; this is test data, **not a proposed parser
or production ID encoding**. Cloud should retain its own durable binding and can
use an opaque ID within the existing contract limits.

No Feishu-specific execution or reply pipeline is needed. The poll client uses
`placeLaunchTarget`, `ExternalConversationSeam`, the normal Bot lookup/pause check,
conversation links, delivery receipts and the reply outbox. The plugin host API
can launch/resume agents or manage automations, and generic webhooks can trigger
automations, but neither supplies this hosted installation identity and original
chat reply binding. They would require a separate bridge, outside this slice.

## Public verification

`src/main/connector-cloud/connector-feishu-lark.test.ts` uses the repository's fake
hosted connector and fake agent provider with the real poll client, native-chat
admission, journal, conversation seam and reply outbox. A separate local contract
check validates normalized delivery and reply examples against the public Cloud
schemas; root tests do not require a Cloud workspace build.

It exercises Feishu and Lark separately, delivery to the selected Bot, repeated
delivery, the original conversation's final answer, refusal to send another app,
tenant, thread or platform into an existing chat, and Slack with an older Cloud
that advertises neither capability. `connector-reply-boundaries.test.ts` also
reopens a journal with pending new-source replies against an older-schema fake
Cloud: Slack snapshots still land, unsupported replies remain local, and the
original replies drain when compatible capabilities return.
`connector-source-turns.test.ts` verifies terminal events observed before hello
and during capability loss survive restart without blocking Slack. These are **mock
integration tests**, not
proof of a Feishu/Lark webhook or live reply. They prove key preservation, not
that Cloud derived the key or authenticated a sender correctly.

The chat uses existing source text and generic side-chat presentation. New brand
icons, source-specific links and avatar-host allowlists are deferred; unrecognised
links/avatars continue to be dropped. No Connectors setup entry is exposed.

## Host binary downgrade restriction

**Do not run a host predating this change against a profile that has admitted
Feishu/Lark work.** Its older link reader skips unknown sources; writing another
link can erase those skipped rows. Its legacy reply drain can mark an unknown
source's pending answer sent without posting it. Re-upgrading cannot recover
state that the old binary has already discarded. This patch cannot retrofit
released binaries and does not make ordinary binary downgrade safe.

Before enabling either capability for real installations, maintainers must ship
and adopt a compatibility release that preserves unknown link rows and leaves
unknown-source replies unsent, or establish an enforced profile downgrade guard
and recovery procedure. The current sender now retains unknown-source replies,
but older link writers still require that rollout work. Until then, keep both
hosted capabilities disabled outside disposable test profiles. If an affected
installation needs rollback, keep its compatible host version while rolling back
Cloud, or use a separate clean profile; retain the affected profile and its
pending replies for recovery. Do not mutate it with an older binary.

This is a **production-enablement blocker**, in addition to the private adapter.
A generic plain code revert is safe only before any new-source data was admitted.

## Remaining hosted work and decisions

1. Agree the two capability identifiers and the installation-to-Bot management
   contract. No credential submission endpoint is proposed here. Decide how the
   owner binds an existing self-built app, grants/revokes Who can ask, sees status,
   and disconnects it. The host's persisted Bot installation summary and
   `hostNeedsConnector` integration need that contract: a Feishu-only installation
   cannot yet keep the production poll loop open by itself.
2. Implement platform-specific API routing, HTTPS URL verification, signature and
   event decryption, binding to app/tenant, permitted human group mentions only,
   and bot-message rejection. Store message-ID deduplication and durable admission
   before acknowledging within the provider deadline. Queue while the host is
   offline and respect paused/deleted Bots.
3. Send progress and final replies as the same installed app in the original
   thread through the existing outbox, with idempotent retries. Decide unsupported
   prompt, attachment, deleted-thread and revoked-installation behaviour. Maintain
   readable/retriable existing conversations during a capability rollback. The
   public host defers unsupported sources and retains pending replies; Cloud must
   preserve their stored installation/thread bindings.
4. Verify TLS and encryption at rest for credentials, message content, pending
   deliveries and replies, including key access, rotation, retention and redacted
   logs. This patch does not implement or prove hosted encryption. Existing Orca
   local journals/receipts retain their current storage behaviour; this change
   does not add local at-rest encryption or claim end-to-end encryption.
5. Plan a coordinated cutover of the **same** existing app's callback with the old
   listener (`trip-codecare-agent`) stopped, and a rollback that avoids competing
   listeners or duplicate runs. No live app, subscription or service was changed.
   Validate authorised and unauthorised senders, bot rejection, replay, offline
   delivery, tenant isolation and real original-thread replies on both platforms.

A real hosted round trip and deployment remain blocked on the private service.
