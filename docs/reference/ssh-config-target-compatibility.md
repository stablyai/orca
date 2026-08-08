# SSH Config Target Compatibility

## Problem

- `src/main/ssh/ssh-connection-utils.ts:108` resolves OpenSSH config with `ssh -G`, but then prefers the persisted `target.host` over `resolved.hostname`.
- `src/main/ssh/ssh-connection-utils.ts:109` treats persisted port `22` as an explicit override, so a config-host target can ignore a resolved non-default `Port`.
- `src/main/ssh/ssh-config-parser.ts:210` imports config aliases with `host` set to the alias when the concrete `Host` block lacks an inline `HostName`; later `ssh -G` may know the real host, but the connection path ignores it.
- `src/renderer/src/components/settings/SshPane.tsx:63` requires both host and username, even though OpenSSH config aliases can resolve the user and users commonly paste `user@host:port` targets.
- `src/main/ssh/ssh-config-parser.ts:330` parses `ForwardAgent`, but `src/main/ssh/ssh-connection-utils.ts:112` did not pass it into ssh2, so remote git commands that rely on the local agent could fail.

## Goal

Make Orca behave like a mature SSH client for common config-host flows: aliases imported from `~/.ssh/config`, aliases with inherited `HostName`/`Port`, and pasted SSH targets should connect without users re-entering information that OpenSSH can resolve.

## Non-goals

- Do not add persistent secret storage for SSH passwords or key passphrases.
- Do not redesign the whole SSH settings page.
- Do not change relay deployment or remote PTY lease semantics.
- Do not add a known-host trust UI in this patch.

## Design

1. Preserve explicit target overrides while letting config aliases use resolved values.
   - In `buildConnectConfig`, prefer `resolved.hostname` only when the persisted host is blank, the same as `configHost`, or the same as the label.
   - Prefer `resolved.port` when the target is a config-host target still on the default `22`; keep non-default target ports as explicit overrides.
   - Continue using target username first, then resolved user.

2. Honor resolved agent forwarding where ssh2 can support it.
   - Set `agentForward` only when resolved config requested forwarding and an agent is actually configured.
   - Leave system-SSH transport unchanged because it already delegates to OpenSSH config.

3. Normalize settings form drafts before save.
   - Accept `ssh://user@host:port`, `user@host:port`, and plain aliases in the Host field.
   - Auto-fill username and port from pasted inputs only when the dedicated fields are still empty/default.
   - Allow username to be omitted; `ssh -G` can provide it during connect.

4. Keep UI changes small.
   - Rename copy only where needed to avoid implying username is mandatory.
   - Render username-less targets without a leading `@`.
   - Do not introduce new colors, typography, or layout patterns.

5. Cover behavior with focused tests.
   - Add connection-config tests for config-host resolved hostname/port precedence.
   - Add connection-config tests for `ForwardAgent yes`.
   - Add renderer utility tests for pasted SSH target normalization.

## Edge Cases

- Explicit non-default port in Orca still wins over `ssh -G`.
- Empty or unparsable host input remains invalid.
- IPv6 bracket syntax is accepted for `ssh://` URLs and preserved conservatively for scp-like inputs.
- Plain config aliases remain valid even without a username.

## Rollout

1. Add the renderer draft-normalization helper and tests.
2. Wire the SSH settings form save path and labels to the helper.
3. Update `buildConnectConfig` precedence/agent-forwarding and tests.
4. Clean up username-less target display.
5. Run focused tests and typecheck/lint where feasible.
