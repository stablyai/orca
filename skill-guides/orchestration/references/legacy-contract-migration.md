# Legacy contract migration

Follow a legacy label's printed command exactly, with the same executable.

Only if the original coordinator is gone or cannot prove ownership, take over
from your own terminal:

```text
ORCA orchestration run-use --id <adopted_run_id> --takeover-legacy
ORCA orchestration check --run <adopted_run_id>
```

Never take over from an active coordinator, and never start a second editor
just because Orca updated.
