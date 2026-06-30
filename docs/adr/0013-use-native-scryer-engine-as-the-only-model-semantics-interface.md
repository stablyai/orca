# Use Native Scryer Engine as the only model semantics interface

Architecture UI, Electron IPC, Orca CLI, agent runtime, drift/sync, and tests must call the Native Scryer Engine or typed wrappers. This keeps parsing, validation, planned/committed policy, locks, leases, history, anchors, build edges, drift semantics, and atomic IO behind one interface.
