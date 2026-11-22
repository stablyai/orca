# Local DingTalk connector

## Goal

Orca can receive messages from selected DingTalk groups, give each group a native bot conversation, and send completed replies back through `dws`. The connector runs in the Orca process and does not use Orca Cloud, MCP, or a webhook.

## Usage

The owner selects a `dws` profile, a bot, and one or more groups in the local configuration file. Each group has a wake rule and a reply rule. The connector reads the file when Orca starts.

An inbound event becomes a `ConversationKey` with source `dingtalk` and an opaque external id. The connector calls `ExternalConversationSeam.start` for a new group conversation and `ExternalConversationSeam.send` for a linked conversation.

When the seam reports a delivered turn ending, the connector creates a durable reply row. An approved reply is sent with `dws chat message send --uuid <stable-id>`. An uncertain send stays visible for manual resolution.

## Chosen shape

The connector owns a durable ledger and a pure reconciler. The ledger stores inbound messages, conversation anchors, turn outcomes, replies, and watermarks. The reconciler derives commands from the current ledger and live process state. Stream events, seam events, and startup all wake the same reconciler.

The ledger uses one writer and atomic persistence. Each message and reply has a stable key. Replaying an event inserts no second row. A reply enters `sending` before `dws` starts, so a restart can classify the unfinished operation. Group sends use a stable UUID because the current `dws` contract documents idempotency for `send`. Quote replies remain manual when their result is uncertain.

The `dws` adapter parses command output at its boundary and exposes typed domain values. The connector does not import MCP or listener entrypoints. The seam remains responsible for native chat creation, delivery receipts, and turn serialization.

The source union gains `dingtalk` in local external-conversation code. The cloud connector contract keeps its existing source union. This prevents a local source from entering cloud polling or cloud event serialization.

## Module map

- `src/main/dingtalk-local/dingtalk-domain.ts` owns branded identifiers, setup, ledger rows, and stable keys.
- `src/main/dingtalk-local/dingtalk-ledger.ts` owns durable state and compare-and-set transitions.
- `src/main/dingtalk-local/dingtalk-reconcile.ts` derives idempotent commands from state.
- `src/main/dingtalk-local/dingtalk-inbound.ts` parses and filters messages into domain rows.
- `src/main/dingtalk-local/dingtalk-turns.ts` attributes seam events to delivered messages.
- `src/main/dingtalk-local/dingtalk-local-connector.ts` owns lifecycle, consumers, and the seam watcher.
- `src/main/dingtalk-local/dingtalk-local-recovery.ts` classifies unfinished ledger work after a restart.
- `src/main/dingtalk-local/dws/` contains the local `dws` boundary adapter.
- `src/shared/connectors/external-conversation-link.ts` and source-sensitive local helpers accept `dingtalk`.

The connector keeps account credentials and group subscriptions in host-local state. Bot records hold no `dws` credentials.

## Alternatives rejected

The sidecar listener plus local IPC shape duplicates delivery state and adds a second lifecycle. The in-process coordinator gives Orca one owner for consumers and native conversations.

The cloud connector protocol is not used locally. It would import cloud hello, poll, feature, and acknowledgement rules without adding a capability the local seam lacks.

The MCP and webhook bridge remains available as a compatibility path. It cannot provide native external-conversation links or reliable turn attribution.

## Risks

- `dws` streams can lose events during reconnects. History catch-up is a follow-up before enabling unattended replies.
- An Orca account reset can drop seam watchers. The connector needs a reset callback before unattended use.
- Each delivery-started turn queues one reply, keyed by conversation and turn. When one delivery alone started the turn, `turn-started` names it, and only that message is attributed. Otherwise the turn is attributed to every message of the conversation still in flight, since a busy chat folds those into its running turn. A turn whose start predates the watch, as after a restart, has no turn ID and gets no reply.
- Local ledger text contains group messages and replies. The store uses a private directory and mode `0600` files.

## Verification

Pure tests cover source parsing, event filtering, stable ids, reconciliation, turn attribution, and state transitions. The fake `dws` send boundary has a smoke test. A real external-conversation end-to-end test remains open.
