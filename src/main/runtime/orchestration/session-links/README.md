# Session links: first slice

A person explicitly pairs two existing local Claude or Codex chats from **Work together…** in a chat header. The preview shows the partner chat, workspace, branch, task, story and roles. Only the desktop transport can create or resume a link. One current link is allowed per conversation; structured workers and remote sessions are excluded from this slice.

The durable link and chronological journal live in the host orchestration SQLite database. Link messages also use the existing orchestration message store as inspect-only mail. Ordinary mail resets do not erase the link journal. Agent messages retain typed agent provenance and a link label on desktop and mobile. Model requests use the session's normal provider/account; local transport does not mean offline inference.

## Delivery and control

- Introductions and peer messages enter a durable outbox. Idle chats wake through the existing structured send path. Busy chats finish their turn first. Pending human questions, approvals and queued human input block automatic admission. Owner notes take priority over peer backlog and remain writable when the peer outbox is full.
- Admission is rechecked under host serialization immediately before sending. Closing a chat, `/clear`, an unverified tab index or changing its captured workspace/context pauses the link. It never binds silently to a successor.
- Questions/checkpoints have message IDs. The sender waits for an accepted reply naming that exact ID. Clarifying questions may still arrive; unrelated status does not release the checkpoint.
- Pause retains mail and allows an already running turn to finish. Stop pauses immediately and requests cancellation only for a turn whose accepted submission is proved to belong to this link. An unrelated human turn keeps running. Cancellation identity is saved before the effect. Stop receipts are durable: retries cannot retarget work admitted after an owner continuation. An initially unprovable stop stays unconfirmed until a new explicit Stop action. An unconfirmed stop is shown in the journal; use the chat's normal Stop control if a provider has not yet published a provable turn.
- Either participant may request urgent Stop or end the link. Controls echo the originating delivery operation from the message. Only that operation's proved current turn is allowed to finish its control reply; an older background command cannot exempt a later turn. Missing/foreign origins are refused before effects. Ending cancels queued mail, releases both conversation memberships and retains the journal. Reconnecting requires another human-created link.
- New links default to 20 automatic agent wake-ups per owner continuation, including introductions. The owner can change this limit or explicitly select continuation until reviewer acceptance. Exhaustion pauses the link with its reason; the owner can adjust the limit and resume in one action. Three repeated messages still pause the link. Legacy links without a stored policy retain their six-turn/twelve-message limits. These are work limits, not a dollar-spend guarantee.
- An agent cannot create/resume a link or send an owner note. Owner decisions pause the link until a genuine desktop owner answer resumes it atomically. Peer messages never confer spending, privacy or irreversible-action approval.

## Recovery

Every caller mutation has a stable operation ID. The desktop retains an uncertain action and retries the original payload/ID; the CLI prints the operation ID in JSON and reports it with failures. Successful retries replay the existing record.

Each reserved delivery stores a separate provider operation ID before dispatch. Accepted receipts reconcile without another send. A proved rejection may be retried only on explicit owner continuation. Missing/unknown receipts are retained for review and never reminted, including after restart. Later accepted receipts may reconcile the original uncertain operation. This deliberately prefers a visible stalled delivery to a duplicate model turn.

Generic send, reply, ask and group fan-out to the paired peer are fenced after recipient/Run/Dispatch resolution so they cannot bypass the link's queue, pause or limits. This is an application authority boundary, not isolation against an agent with arbitrary access to the same user's OS/files.

## Validation

Focused tests use real orchestration SQLite storage and the actual structured host with test provider adapters, without sending prompts to external models. They cover restart, lost responses, owner authority, human prompt gates, admission races, correlation, alias fencing, budget exhaustion and cancellation provenance. Fixtures render the actual dialog in both themes. Real Claude/Codex acceptance remains a separate check after installing the feature build and selecting the exact intended chats.

The acceptance scenario pairs an implementer with a reviewer: the implementer sends a checkpoint, the reviewer accepts it or asks the owner a specific question, and implementation continues within existing permissions. The link itself never authorizes spending or access to restricted data.

## Deferred

Dedicated mobile link controls, remote links, multiple peers, file-write collision detection, editable live roles are outside this slice. Mobile preserves link attribution and ordinary chat participation. Existing orchestration Runs/Dispatches keep their own lifecycle authority.

An unconfirmed delivery can be marked reviewed only by the desktop owner after checking the recipient chat. This cancels that outbox event without changing its original operation, reserves no send, and leaves the link paused. Resume admits later messages only. A late receipt for the reviewed event cannot resend it.
