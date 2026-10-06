# Runtime RPC methods

Implements host-owned operations exposed through runtime RPC.

Profile create/support admission uses the trusted caller context; paired callers retain ordinary structured sessions and cleanup.

Structured session creation captures account homes and profile identity before acquisition. Shared request contracts live in `src/shared`; Claude execution and recovery belong to [Claude sessions](../../../claude/README.md).
