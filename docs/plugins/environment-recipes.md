# Environment recipes

Environment recipes let a plugin manage a company's development machines through its existing CLI. The provider can list existing long-lived machines, create ephemeral sandboxes, delete, sleep, resume/wake and archive. Orca remains responsible for SSH connection, workspace ownership, terminals and agent status.

The first three draft layers define the protocol, validate artifacts and run explicitly authorized commands. They do not yet register providers in the marketplace or expose actions in the application. Those integrations must use the contracts below before this feature is considered shipped.

## Provider identity and commands

One plugin may contribute multiple recipes. Each provider has the stable identity `<publisher>.<plugin-id>/<recipe-id>`; each remote resource has its provider-assigned ID and revision. Display names are not identities. Two providers may have resources named `my-pod` without sharing authority.

The strict recipe artifact declares `schemaVersion: 1`, `id`, `name`, `description`, `lifetime` (`long-lived`, `ephemeral` or `both`), optional create fields and `commands`. Each command has a literal `program`, `args` array and a timeout from 1 to 600 seconds. `list` is required; other actions are optional. Sleep requires resume. Commands do not declare shell interpolation or environment credentials. Create fields have a label, optional explanation, required flag and optional choices.

```json
{
  "schemaVersion": 1,
  "id": "devpods",
  "name": "Company development pods",
  "description": "Connect to your existing pod or create a temporary environment.",
  "lifetime": "both",
  "createFields": [{ "id": "region", "label": "Region", "required": true,
    "choices": ["east", "west"] }],
  "commands": {
    "list": { "program": "company-dev", "args": ["orca", "list"] },
    "create": { "program": "company-dev", "args": ["orca", "create"] },
    "delete": { "program": "company-dev", "args": ["orca", "delete"] },
    "sleep": { "program": "company-dev", "args": ["orca", "sleep"] },
    "resume": { "program": "company-dev", "args": ["orca", "resume"] },
    "archive": { "program": "company-dev", "args": ["orca", "archive"] }
  }
}
```

Author scripts are not run on installation. Lifecycle execution is privileged host code, never a data-pack extension. Review must show all declared commands and the execution host, bind the exact source/content/recipe digest and distinguish the plugin's identity from the resource name. A new action or changed executable must not inherit earlier approval. The executor requires a host-supplied current authorization plus its revocation signal; the app integration must obtain that authorization from the existing plugin approval store.

The host resolves the declared program on its own machine and supplies a deliberate environment and working directory. The executor uses Orca's process package, which handles hidden Windows processes, argument encoding, output limits and owned-process termination. Host-selected credentials must never enter catalog JSON, recipe files, public response data or screenshots. Existing corporate CLI login can supply its own credentials; the future host adapter controls which environment it passes.

## JSON protocol

Every command receives one JSON request on stdin, with `protocolVersion: 1`, a UUID `operationId`, `providerId` and `action`. Create receives declared `parameters`; list optionally receives a cursor. Delete, sleep, resume and archive require a resource ID and expected revision. Provider implementations must compare that revision and implement idempotence keyed by operation ID. The parser cannot enforce a remote backend's atomicity.

Stdout is one JSON response echoing protocol version, operation, provider and action. List returns `kind: "inventory"`, bounded resources and an optional next cursor. Other successful actions return `kind: "resource"` and the same selected resource identity. A provider error returns a bounded code (`conflict`, `not-found`, `authentication-required`, `unsupported` or `unavailable`) and message.

Resources include `id`, `name`, `revision`, `lifetime` and state. Only running resources may advertise an SSH connection: host, port, username, optional local SSH config alias and absolute project root. Passwords, private keys and executable proxy commands are not protocol fields. Connection data remains subject to the existing host SSH trust and destination review, rather than directly spawning a returned command.

Requests are limited to 32 KiB; responses to 512 KiB and 256 resources per page, with independent JSON depth/token limits. Control bytes, unknown fields, duplicate inventory identities, unrelated operation/resource responses and success responses that do not confirm the requested transition are rejected. Shell metacharacters in IDs or parameters remain JSON data; arguments remain literal.

## Outcomes and lifecycle meaning

- **Create:** return a newly running resource. Connecting to it is a separate Orca action.
- **List:** explicitly refresh provider inventory. Cached rows are not proof a machine still exists.
- **Sleep:** confirm provider sleep, then retire owned connections. Disconnecting alone is not sleep.
- **Resume / wake:** confirm running state and fresh SSH details; then use the ordinary host connection flow.
- **Archive:** call the separately declared provider action. It is not an alias for sleep, removal from the sidebar or deletion. The UX must explain the provider's consequences before confirmation.
- **Delete:** destructive provider operation with explicit confirmation. Removing a saved Orca connection must remain a separate action.

Cancellation, timeouts, oversized output, nonzero exit, malformed response or authorization withdrawal produce an **unverifiable** outcome after execution may have begun. A provider may have applied a mutation already. Preserve the resource and pending operation, refresh/reconcile through list, and do not automatically retry or present cancellation as rollback. Refusal before spawn is a separate result. Provider errors are structured responses; raw stdout/stderr are not exposed as error messages.

## Required application integration

Add **Environment providers** to catalog discovery and **Environments** to connection management. A user installs/reviews a provider, refreshes inventory, chooses a machine, then connects. Create opens a small labeled form; sleep/wake fit the row's current provider state. Archive/delete show specific consequences and selected resource identity. Progress and cancellation belong to that exact operation; focus, keyboard, empty/loading/stale/error states and disabled unsupported actions are part of the feature.

Keep provider inventory, actual SSH connection state and Orca workspace archive state separate. Keep long-lived resources independent of any repository or workspace; deleting a workspace cannot implicitly delete them. Provider inventory/pending operations must persist with source-bound ownership and survive interrupted mutations. Serialize mutations per provider/resource and refuse changed revisions.

The execution host owns the provider CLI, credentials, inventory and subprocesses. Paired/managed hosts negotiate support. No local fallback is allowed when the selected host is unavailable. Existing workspace recipes remain compatible; their create/suspend/resume/destroy commands can be adapted explicitly, while list and provider archive require real implementations. Folder workspaces and machines without a Git repository are first-class.

Before release: qualify actual provider installation and consent, all six actions, an existing long-lived host and ephemeral sandbox, normal SSH connection/terminal/workspace behavior, disabled/changed plugins, failed/cancelled/interrupted operations, restart, competing clients, source spoofing, Windows and a paired execution host. Historical plugin screenshots do not prove this new provider UI.
