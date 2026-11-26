# Bot app check

`BOT_MCP_APPS` in `src/shared/bots/bot-mcp-apps.ts` is the list of vendor MCP servers that a bot's **Add to** menu offers. The weekly `Bot App Check` workflow probes each one live (an app with a URL `variable` at each of its `choices`, or at its default host) so a server that stops working the way we list it gets noticed before users hit it.

```sh
node config/scripts/bot-apps/bot-app-catalog-smoke.mjs [report.json]
```

It prints one PASS/FAIL line per app, writes a JSON report when given a path, and exits 1 if any app fails.

## What each kind must do

- `signIn: 'none'`: an unauthenticated MCP `initialize`, then `tools/list`, both succeed.
- `signIn: 'browser'`: the bot's CLI will sign in through OAuth, so the server must make that possible without any setup on our side:
  - an unauthenticated `initialize` gets `401` with a `Bearer` `WWW-Authenticate` challenge;
  - protected-resource metadata (RFC 9728) is found at the challenge's `resource_metadata` URL, or at the well-known path when the challenge names none, and its `resource` covers the app URL;
  - one of its authorization servers publishes metadata (RFC 8414, or OpenID discovery as a fallback) with a `registration_endpoint`, response type `code`, and PKCE method `S256`.

Documents are validated with the MCP SDK's own schemas.

## Safety

The probe talks to third-party servers, so it stays read-only and narrow: https only, every host must resolve to public addresses (the connection is pinned to the vetted address), bodies stop at 1 MB, each request has a deadline, GET redirects are followed by hand under the same rules, and the only POST goes to the app's own MCP URL. It never registers a client and never sends credentials.

## Adding an app

Add the entry to `BOT_MCP_APPS`, run the command above, and include its passing output in the PR.

Check the vendor's docs for a list of approved MCP clients first, and skip an app that restricts clients: its server passes this check but refuses Orca's sign-in.

## Files

- `bot-app-catalog-smoke.mjs`: entry point the workflow runs.
- `app-kind-check.mjs`: the per-kind rules.
- `guarded-request.mjs`, `public-address.mjs`: the restricted HTTPS client.
