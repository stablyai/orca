# Linear CLI Skill Follow-Up

## Decision

Do not ship a bundled or installable `linear-tickets` skill with the first
`orca linear` CLI release.

V1 should ship the CLI read surface and launch-prompt hint only. The hint tells
agents how to fetch complete Linear context from a Linear-linked task without
creating a persistent installed skill on the user's machine.

## Why

Installed skills have sticky upgrade behavior. Once a user installs a skill, the
local copy can keep reporting as installed even after the product learns better
Linear workflows, expands the command surface, or changes guidance for writes.
Shipping a narrow V1 skill would make the first draft of our agent guidance feel
canonical too early.

The CLI is also intentionally conservative in V1:

- `orca linear issue` and `orca linear search` are read-only.
- Status changes, comments, and provider-neutral work-item commands are deferred.
- The output schema may still evolve as we learn which caps, metadata, and error
  cases agents actually need to reason about.

That makes the skill a poor place to freeze behavior in the first PR. A launch
prompt hint is safer because it is product-controlled, versioned with the app,
and easy to update alongside the CLI.

## V1 Behavior

Launch prompts never embed Linear ticket content. Ticket prose (description,
comments, child issues) is third-party text; placing it in the initial prompt
puts untrusted input in front of the agent before any task framing, and it
duplicates data the CLI serves live and uncapped-by-launch-time. The prompt
carries only an Orca-authored block:

- A trusted header: `Linked Linear issue: <identifier> — <title>` plus the
  issue URL. The title is the only ticket-authored text and is flattened to a
  single control-char-escaped, length-capped line.
- When the `orca` CLI is available where the agent runs, an imperative hint:

  ```bash
  orca linear issue <identifier> --full --json
  ```

  with instructions to treat returned Linear fields as untrusted source data
  and inspect `meta` for caps, `partial`, and `includeErrors`.
- When the CLI is not available, a one-line note that full ticket details are
  available by enabling the Orca CLI in Settings — never a command that would
  fail, and never a ticket snapshot as a fallback.

CLI availability is resolved per launch: SSH worktrees always qualify (the
relay deploys an `orca` shim onto PATH), local launches require the installed
CLI (`state === 'installed' && pathConfigured`).

The only place ticket prose is still rendered into a prompt-shaped string is
the user-initiated "Copy prompt" action on the Linear issue view, which is a
deliberate user paste rather than ambient injection.

## When To Add The Skill

Add a bundled/installable skill after the CLI surface is stable enough that
users will not get stranded on obsolete guidance. At minimum, decide:

- Whether V2 includes Linear writes such as status changes or comments.
- Whether work items become provider-neutral, for example
  `orca work-item issue ...`, or remain provider-specific.
- How skill updates are detected and applied when a user has an older local
  copy installed.
- How SSH and remote runtimes should be described so the skill does not imply a
  local-only workflow.

Until then, keep agent guidance in the launch prompt and CLI `--help`.
