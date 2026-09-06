# Kaneo task URLs

Orca can resolve a pasted Kaneo task URL in the **Smart** field of Create worktree
or Create folder workspace. Select the task result to use its title as the
workspace name and keep a link to the task. When starting an agent, Orca includes
the fetched title and description as bounded, explicitly marked source context.
User-written instructions and names remain separate from the imported task.

## Connect

1. In Kaneo, create an API key under **Settings → Account → Developer Settings**.
2. In Orca, open **Settings → Integrations → Kaneo**.
3. Enter your instance's HTTPS origin, such as `https://tasks.example.com`, and
   the API key. Save the connection.
4. Paste a task URL into **Smart**, then select the resolved task.

The supported URL shape is:

```text
https://tasks.example.com/dashboard/workspace/<workspace-id>/project/<project-id>/task/<task-id>
```

Trailing slashes, query strings and fragments are accepted and removed from the
stored task link. Ordinary text and other providers' links retain their existing
behavior. An unresolved Kaneo URL blocks creation in Smart mode; choose Name mode
to deliberately use literal text instead.

One Kaneo instance is connected per Orca runtime. The integration supports Kaneo
Cloud and self-hosted instances using the documented Bearer API-key authentication
and current task routes. HTTP origins and deployments under a URL subpath are not
supported in this initial integration.

## Runtime and credential behavior

Connections follow Orca's selected runtime. With a paired remote runtime selected,
credentials and API requests stay on that runtime; local credentials are never a
fallback for a failed remote request. SSH-backed worktrees use the existing
execution routing independently of task lookup. Folder workspaces retain the same
Kaneo link and launch-context behavior.

Orca stores the credential in an encrypted envelope using its existing secret
store, with owner-only plaintext storage when encryption is unavailable. The
instance origin is bound to the key inside that envelope. Status checks read only
non-secret metadata. Requests never send a key to an origin inferred solely from a
pasted URL and never follow HTTP redirects.

Remote runtimes must advertise `kaneo.task-link.v1` before a Kaneo link can be
created or written there. Older runtimes show an update-required error. No protocol
version bump is needed; existing providers and methods are unchanged.

## Scope and maintenance

This integration reads tasks; it does not browse boards, update task state, add
comments, or change Kaneo itself. The selected title, URL, and number persist in
workspace metadata. Description context is captured for initial agent launch,
not synchronized as a live issue cache.

The client verifies task/project/workspace identity using the task endpoint and a
project list scoped to the workspace. It bounds response sizes and request time,
cancels superseded lookups, and ignores stale results across input and runtime
changes. Task prose uses Orca's existing untrusted-context wrapper.

Provider contracts are documented in [Kaneo's API reference](https://kaneo.app/docs/api-reference/introduction)
and [authentication guide](https://kaneo.app/docs/api-reference/authentication).
