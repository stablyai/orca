# OMP runtime session provenance

OMP computes whether a runtime session is a task child, but the released
`ExtensionContext` does not expose that value. The status extension therefore uses
the session manager's parent header and nested task transcript path only when a
root owner is already known. A nested transcript with no known owner remains
eligible because it may have been resumed directly as the pane's main session.

The remaining child-first case is inherently ambiguous to Orca: task children and
resumed child transcripts have the same public session-manager shape. A complete
child-first fence requires OMP to expose its computed `agentKind` through
`ExtensionRunner.createContext`; until then the conservative fallback avoids
silencing valid resumed sessions.

Older runtimes retain the manager-identity guard. That guard assumes the main
session reaches Orca's callback before any child. An earlier user extension can
initialize a child during session_start and violate that assumption. Keep the
ownership merge assessment conditional until the runtime API is available and the
combined flow is validated. Neither callback timeouts, UI presence, nor transcript
paths establish runtime ownership.

The guard remains scoped to one pane and launch token. It does not define how
several independent SDK/ACP roots sharing one process and pane should be attributed.
