---
name: project-asana-pat-integration
description: Security patterns and findings for PR #4881 — Asana PAT integration. Token storage, IPC boundary, URL construction, renderer safety.
metadata:
  type: project
---

Asana PAT integration (PR #4881) reviewed on 2026-06-08.

**Why:** Adds Asana Personal Access Token support. Models Jira multi-site PAT pattern.

**How to apply:** Use as baseline when reviewing future tracker integrations or changes to the Asana module.

## Token Storage
- Token encrypted via `electron.safeStorage` into `~/.orca/asana-tokens/<base64url(workspaceId)>.enc` (mode 0o600)
- When `safeStorage.isEncryptionAvailable()` is false, token stored in plaintext with `console.warn` — same fallback as Jira
- Token is never returned to renderer; `getStatus()` returns only `AsanaConnectionStatus` (no `authorization` field)
- `getClients()` exposes `authorization: "Bearer <token>"` but is only called in main-process `issues.ts`, never flows to IPC/RPC handlers

## IPC/RPC Boundary
- IPC handlers in `src/main/ipc/asana.ts` do manual type checking (not Zod) — parallel to Jira pattern
- RPC methods in `src/main/runtime/rpc/methods/asana.ts` use Zod schemas (requiredString, OptionalString, etc.)
- `workspaceId` from renderer is only used to *filter* the workspace list loaded from disk; it never flows directly into URL paths
- `workspace.id` used in URL paths always comes from Asana API response (trusted origin), not user input

## URL Construction
- All GIDs and workspace IDs in URL paths use `encodeURIComponent()` — no injection risk
- `URLSearchParams` used for query parameters — safe serialization
- `ASANA_API_BASE` is hardcoded (`https://app.asana.com/api/1.0`) — no SSRF via user-controlled base

## Renderer Safety
- `CommentMarkdown` renders Asana comment text via `rehypeSanitize` with `defaultSchema` — href protocols restricted to http/https/irc/mailto/xmpp; no `javascript:` bypass
- Task title/name/URL rendered as React text nodes (auto-escaped), not `dangerouslySetInnerHTML`
- `shell.openUrl` validates `http:` or `https:` protocol before calling `shell.openExternal` — no `javascript:` or `file:` exec

## Findings: No exploitable issues above confidence 80
- plaintext fallback is a noted degraded state (same as Jira), not exploitable in normal conditions
- `console.warn` logs the warning but not the token value
