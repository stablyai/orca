# Legacy contract migration

Follow a legacy label's printed command exactly, with the same executable.

This applies only to the Run Orca adopted automatically from the legacy
contract. For any other Run whose coordinator is gone, use plain `run-use`
([Recovery and cleanup](recovery-and-cleanup.md#coordinator-gone)).

Only if the adopted Run's original coordinator is gone or cannot prove
ownership, take over from your own terminal:

```text
ORCA orchestration run-use --id <adopted_run_id> --takeover-legacy
ORCA orchestration check --run <adopted_run_id>
```

Never take over from an active coordinator, and never start a second editor
just because Orca updated.
