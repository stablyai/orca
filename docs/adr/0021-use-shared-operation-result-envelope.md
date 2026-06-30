# Use a shared operation result and error envelope

Every Native Scryer Engine operation returns the same success-or-failure envelope. Operation-specific contracts define payload and error details, while CLI, IPC, UI, agents, scripts, and tests all consume the shared shape.
