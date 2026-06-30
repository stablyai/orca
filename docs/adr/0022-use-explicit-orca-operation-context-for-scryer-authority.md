# Use explicit Orca operation context for Scryer authority

Every Native Scryer Engine operation receives explicit Orca operation context for caller identity, request tracking, project resolution defaults, edit authority, and run correlation. This replaces hidden caller assumptions with deterministic authority checks while preserving upstream Scryer state semantics.
