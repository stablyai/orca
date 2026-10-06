# Main-process IPC

Registers renderer requests against host-owned services.

- `register-core-handlers/`: application handler composition and lifecycle wiring.
- Provider and feature modules: request validation and delegation to the owning service.
- `agent-profiles.ts`: profile management handlers for the singleton [profile service](../agent-profiles/README.md).
- `settings.ts`: renderer settings updates and their host-authority field boundary.
- `pty/`: terminal creation, authentication preparation and runtime ownership; see [host environment](pty/host-env/README.md) and [runtime](pty/runtime/README.md).

Preload clients live in [preload/api](../../preload/api/README.md); shared DTOs live in `../../shared`.
