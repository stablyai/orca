# Structured session historical repair

Historical repair no longer prevents otherwise safe new admission. Before reservation can replace old lease evidence, the host persists an immutable receipt with exact journal targets, or an explicit abandonment. The new send's own ownership transaction and durable submission remain required.

Conditional repair uses existing item and dispatch row formats inside the existing serialized journal writer. It checks materialization incarnation, epoch, latest mutation sequence, item revision, and alias/submission provenance. Later writes supersede old targets. Unattributed imported or legacy activity becomes unverifiable; a writer fence does not justify inventing an interruption time.

The journal database advances to **version 3** to persist an immutable materialization identity. Destructive suffix repair rotates it in the same transaction. **Older hosts open migrated journals read-only.** Existing-format rows avoid a new wire row kind, but do not remove this downgrade cost.

Receipts survive reservation outside the lease. Capture is limited to 512 targets and 256 KB; records retain at most eight receipts for 24 hours. Unreadable capture, quota exhaustion, and expiry explicitly abandon historical precision and publish a bounded history disclosure when writable. Failed materialization stays retryable without becoming a second execution-truth store or admitting a duplicate owner.
