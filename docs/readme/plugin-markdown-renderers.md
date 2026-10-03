# Native Markdown renderers

Delivery: https://github.com/stablyai/orca/issues/24935

This experimental contract requires a host build containing this delivery.
No released version is currently declared to support it. Authoritative schemas
and types: `src/shared/plugins/plugin-markdown-renderer.ts`.

## Contribution and permission review

```json
{
  "main": "worker.mjs",
  "contributes": {
    "commands": [{ "id": "render-query", "title": "Render query" }],
    "markdownRenderers": [{ "language": "query", "commandId": "render-query" }]
  }
}
```

Each renderer references a declared worker command registered with the existing
`commands.register` API. Invocation reuses `invokeCommand` and `commandResult`;
there is no second worker protocol. Built-in command aliases cannot render blocks.
Languages start with a lowercase letter, contain lowercase letters, digits or
dashes, and are at most 64 characters. `mermaid` is reserved. A manifest allows
at most 16 renderers and cannot repeat a language. Multiple installed providers
for one language produce `ambiguous-provider`; ordering never chooses a winner.

The permission review must list each language and command and disclose that
opening a matching fence sends code and verified document/workspace context to
a trusted Node worker, which can activate without a separate command click.
Semantic output validation does not sandbox worker execution. Existing host
capability checks remain in force. Sorted language/command declarations affect
the consent fingerprint: adding or changing a renderer requires renewed approval.
Fingerprints for plugins without renderers retain their existing meaning.

## Source and render APIs

The preload `plugins` API exposes:

- `listMarkdownRenderers()` returns `{language, pluginKey, available}[]`, including
  disabled or colliding declarations with `available: false`.
- `resolveMarkdownSource({fileId, documentPath, worktreeId, runtimeEnvironmentId})`
  returns `{status: 'resolved', source}` or `unsupported-context` unavailability.
- `renderMarkdown({language, code, source, sessionId, knownRevision?})` returns
  centrally validated semantic output.
- `cancelMarkdownRender({sessionId})` fences pending replies for that renderer
  owner. It does not stop arbitrary worker computation.
- Existing `onChanged(callback)` provider notifications return an unsubscribe
  function. Consumers stop polling and discard stale responses on source
  replacement, disablement and unmount.

`runtimeEnvironmentId` must explicitly be `null` for this initial native local
implementation. SSH, WSL UNC and remote runtime sources fail explicitly. No
active-workspace substitution or client-side read of remote paths is permitted.
Registered folder workspaces, including read-only folders, are supported alongside
Git worktrees. Floating and unregistered sources are refused.

Resolved `source` is `{runtimeId, worktreeId, fileId, documentPath, workspacePath}`.
The host derives process `runtimeId` and canonical absolute paths from the exact
registered workspace and document. It verifies existence, Markdown extension and
realpath containment before and after command invocation. `fileId` is an opaque
editor correlation identity, not an authorization token. Manufacturing a workspace
path or selecting another runtime ID cannot authorize a render.

The worker receives the validated request unchanged and returns:

```json
{
  "sessionId": "block-1",
  "revision": "snapshot-7",
  "output": {
    "kind": "table",
    "columns": ["Note"],
    "rows": [
      [
        {
          "text": "Example",
          "reference": { "path": "notes/example.md", "base": "workspace" }
        }
      ]
    ]
  }
}
```

The session ID must match the request. Revision is an opaque nonempty string
identifying provider snapshot/output state. Consumers may poll with advisory
`knownRevision`, at intervals of at least two seconds and one request in flight
per block. Providers should share cached snapshots/revisions across requests and
avoid collection rescans per block. Responses always include complete output.
Existing commands time out after 30 seconds. Native dispatch allows four pending
calls per provider, 64 sessions per renderer owner and 128 pending calls in total.

## Semantic output and failures

- `{kind: 'table', columns: string[], rows: Cell[][]}`; rows match column count.
- `{kind: 'list', items: Cell[]}`.
- `{kind: 'text', text: string}`.
- `{kind: 'error', message: string}` for a provider query diagnostic.

`Cell` is `{text, state?, reference?}` with optional `normal`, `missing` or `error`
state. All labels/messages are plain text, including HTML-looking characters.
HTML, evaluator, script, style and event-handler fields are rejected. Native
consumers render text and reuse existing document navigation authorization.

References are `{path, base: 'document' | 'workspace'}`. Portable relative POSIX
paths exclude traversal, schemes, absolute paths, backslashes, control characters
and Windows device names. `document` starts at the verified source parent;
`workspace` starts at `source.workspacePath`. The host checks realpath containment,
including existing ancestors of missing notes, and rejects symlink escapes.
Navigation reauthorizes on activation because filesystem state can change.
A configured provider collection/vault does not grant another navigation root:
map contained targets into the source workspace or omit references.

Bounds: 64 Ki source-code characters; 32 columns; 500 rows/items; 256 characters
per column; 4,096 characters per cell/error; 64 Ki text characters; 128 references;
1,024 characters per reference path; 128 characters per session/revision; 4,096
characters per identity field; and 512 KiB serialized worker output.

Results distinguish `rendered` (host-stamped `pluginKey`, session/revision/output),
`unavailable` (`missing-provider`, `disabled-provider`, `ambiguous-provider`,
`unsupported-context`) and `error` (`invalid-request`, `invalid-output`,
`provider-error`, `stale-context`, plus a bounded host message). Raw worker exception
details are withheld. Cancellation, replacement, disablement and renderer
destruction fence late replies. Failures preserve source editing and safe fallback.

## Configuration panels

Sandboxed panels may call existing `settings.get` and `settings.set` through the
session bridge under `settings:own`. The host derives plugin identity from the
approved session and verifies the renderer owner. Caller claims cannot redirect
storage. `settings.get({})` returns `{settings}`; `settings.set({key, value})`
returns `{ok: true}`. Writes retain auditing and existing JSON/key/storage budgets.
These methods reach only the owning plugin's `settings.json`, not global settings,
other plugin stores or secrets. Other worker-only methods remain panel-forbidden.
