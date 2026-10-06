# Preload API bridges

Exposes typed Electron IPC clients through `window.api`.

- Feature `*-bridge.ts` and `*-api.ts` modules: request and event methods for their API namespace.
- `agent-profiles-bridge.ts`: preview, save and unlink using the shared profile management contract.
- `*.test.ts`: bridge payload and subscription behavior.

`../index.ts` assembles these modules against `../api-types.ts`. Host handlers are registered in
[main/ipc](../../main/ipc/README.md); profile validation and mutation ordering belong to the
[main profile service](../../main/agent-profiles/README.md).
