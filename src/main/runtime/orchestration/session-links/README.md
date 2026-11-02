# Session links: first slice

A person explicitly pairs two existing local Claude or Codex chats from **Work together…** in a chat header. The preview shows the partner chat, workspace, branch, task, story and roles. Only the desktop transport can create or resume a link. One current link is allowed per conversation; structured workers and remote sessions are excluded from this slice.

The durable link and chronological journal live in the host orchestration SQLite database. Link messages also use the existing orchestration message store as inspect-only mail. Ordinary mail resets do not erase the link journal. Agent messages retain typed agent provenance and a link label on desktop and mobile. Model requests use the session's normal provider/account; local transport does not mean offline inference.

## Delivery and control

- Introductions and peer messages enter a durable outbox. Idle chats wake through the existing structured send path. Busy chats finish their turn first. Pending human questions, approvals and queued human input block automatic admission. Owner notes take priority over peer backlog and remain writable when the peer outbox is full.
- Admission is rechecked under host serialization immediately before sending. Closing a chat, `/clear`, an unverified tab index or changing its captured workspace/context pauses the link. It never binds silently to a successor.
- Questions/checkpoints have message IDs. The sender waits for an accepted reply naming that exact ID. Clarifying questions may still arrive; unrelated status does not release the checkpoint.
- Pause retains mail and allows an already running turn to finish. Stop pauses immediately and requests cancellation only for a turn whose accepted submission is proved to belong to this link. An unrelated human turn keeps running. Cancellation identity is saved before the effect. An unconfirmed stop is shown in the journal; use the chat's normal Stop control if a provider has not yet published a provable turn.
- Either participant may end the link. Ending cancels queued mail, releases both conversation memberships and retains the journal. Reconnecting requires another human-created link.
- A human continuation grants six automatic delivery attempts, including introductions, and twelve agent messages. Three repeated messages pause the link. These are work limits, not a dollar-spend guarantee.
- An agent cannot create/resume a link or send an owner note. Owner decisions pause the link until a later genuine desktop owner note and explicit continuation. Peer messages never confer spending, privacy or irreversible-action approval.

## Recovery

Every caller mutation has a stable operation ID. The desktop retains an uncertain action and retries the original payload/ID; the CLI prints the operation ID in JSON and reports it with failures. Successful retries replay the existing record.

Each reserved delivery stores a separate provider operation ID before dispatch. Accepted receipts reconcile without another send. A proved rejection may be retried only on explicit owner continuation. Missing/unknown receipts are retained for review and never reminted, including after restart. Later accepted receipts may reconcile the original uncertain operation. This deliberately prefers a visible stalled delivery to a duplicate model turn.

Generic send, reply, ask and group fan-out to the paired peer are fenced after recipient/Run/Dispatch resolution so they cannot bypass the link's queue, pause or limits. This is an application authority boundary, not isolation against an agent with arbitrary access to the same user's OS/files.

## Validation

Focused tests use real orchestration SQLite storage and the actual structured host with test provider adapters, without sending prompts to external models. They cover restart, lost responses, owner authority, human prompt gates, admission races, correlation, alias fencing, budget exhaustion and cancellation provenance. Fixtures render the actual dialog in both themes. Real Claude/Codex acceptance remains a separate check after installing the feature build and selecting the exact intended chats.

The acceptance story is de-identification slice 1b: Codex reports tasks 1–5, Claude reviews or requests the owner, and Codex continues within existing permissions. No paid calls or holdout access are authorized by the link itself.

## Deferred

Dedicated mobile link controls, remote links, multiple peers, file-write collision detection, editable live roles and configurable budgets are outside this slice. Mobile preserves link attribution and ordinary chat participation. Existing orchestration Runs/Dispatches keep their own lifecycle authority.
