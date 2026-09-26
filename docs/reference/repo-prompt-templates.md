# Repo prompt templates: `issueCommand` and `reviewCommand`

A repository can supply the prompt Orca hands the agent when a workspace is
created from a linked work item and the user typed no note of their own. There
are two templates, chosen by what the workspace is linked to:

| Linked item                                | Key             | Built-in default          |
| ------------------------------------------ | --------------- | ------------------------- |
| GitHub issue, GitLab issue                  | `issueCommand`  | `Complete {{artifact_url}}` |
| GitHub pull request, GitLab merge request   | `reviewCommand` | `Review {{artifact_url}}`   |

The naming is deliberately provider-neutral. One key covers pull requests and
merge requests, because they are the same concept on two forges; there is no
`pullRequestCommand` or `mergeRequestCommand`.

`issueCommand` does double duty: besides the draft prompt, Orca can also run it
as a shell command in a terminal when a worktree is created. `reviewCommand` is
prompt-only and is never executed as a command.

## Three configuration layers

For each kind, Orca resolves the template from the first layer that has content:

1. **`<repo>/.orca/issue-command` or `<repo>/.orca/review-command`** — a
   per-user override. Orca writes it for you from Settings and adds `.orca` to
   the repository's `.gitignore`, so it never reaches a commit. Because you own
   this file, it is trusted without prompting.
2. **`orca.yaml`, key `issueCommand:` or `reviewCommand:`** — the tracked
   project default, shared with everyone who clones the repository. Because it
   arrives from the repository rather than from you, it passes the trust gate
   below before it is used.
3. **The built-in default** in the table above.

A blank local override is not an empty template: clearing the field deletes the
file, so the `orca.yaml` value applies again.

On an SSH-hosted repository both the `.orca/` file and `orca.yaml` are read and
written on the execution host, never locally.

## Tokens

Both templates substitute the same two tokens:

- `{{artifact_url}}` — the linked item's URL.
- `{{issue}}` — the linked item's number. It is the issue number for an issue
  and the pull or merge request number for a review; there is no separate token
  for the latter.

## Example `orca.yaml`

```yaml
scripts:
  setup: |
    pnpm install
issueCommand: |
  Complete {{artifact_url}}
reviewCommand: |
  Review !{{issue}} at {{artifact_url}} and list the risks you find.
```

## The trust gate on shared content

Anything that arrives through `orca.yaml` is repository-supplied text. For a
prompt template that text becomes an autonomous agent's instructions, so Orca
asks before using it. The dialog names the kind, shows the exact content, and
states what will actually happen: an `issueCommand` may run on your machine, a
`reviewCommand` becomes the prompt Orca sends the agent. Approving records a
hash of that content, so a later edit to the file asks again. Declining drops
the template and leaves the plain linked-URL draft.

The two kinds are trusted separately: approving a repository's `issueCommand`
does not approve its `reviewCommand`. Approvals are per repository, and the
"always trust this repository" option in the dialog covers both.

Local `.orca/` overrides skip the dialog, since you wrote them.

## Remote hosts running an older Orca

A client can be paired with a remote Orca host that predates `reviewCommand`.
Reading the review template from such a host fails, and Orca falls back to the
built-in `Review {{artifact_url}}` — a local constant, never repository text.
Saving a review override against such a host surfaces an error rather than
writing to `.orca/issue-command`; see
[`remote-wire-compatibility.md`](./remote-wire-compatibility.md).

## Where this lives in the app

Settings → repository → Repository Hooks has one field per kind, "Custom GitHub
Issue Command" and "Custom Review Command". Each edits that repository's local
`.orca/` override and shows the `orca.yaml` value as the fallback.
