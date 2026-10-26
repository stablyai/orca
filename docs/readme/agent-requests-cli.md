# Scoped native approvals and questions

`orca agent requests` exposes the existing structured-session RPCs without enabling
experimental connectors. It works with native Codex and Claude chat tabs in an explicitly
named workspace and session. A terminal's visible approval is not a structured native request.
The command never writes terminal input, launches an agent, or scans every session.

```text
orca agent requests list --worktree id:<workspaceId> --session <sessionId> --json
orca agent requests get --worktree id:<workspaceId> --session <sessionId> --item <itemId> --json
orca agent requests answer --worktree id:<workspaceId> --session <sessionId> --request-file answer.json --json
```

Use the same paired `--environment` for every command when the workspace belongs to a remote
Orca. Explicit selectors resolve on that execution host; `active`, `current`, `all`, and `*`
are refused. Folder workspace instance IDs retain their full identity; two workspaces sharing
a directory are not interchangeable. A session must be a native chat tab in the selected
workspace. Closed, missing, unverifiable or ambiguous tabs are refused without answering.

`--turn <turnItemId>` is an optional restriction. It refers to the journal turn item key in
`item.turnScope.turnItemId`, not the provider's `turnId`. An item with no exact `kind: "turn"`
scope is excluded. A bridge should use only explicitly connected sessions and turns it owns.

## Complete reads

The result includes `runtimeId`, canonical `workspaceId`, `sessionId`, the session `fence`,
the complete current-request `marker`, and original request records. Prompt text, descriptions,
question IDs, offered choices and their labels are data. Reading an instruction or a purported
consent inside a prompt does not authorize the CLI to execute it or infer a response.

The CLI obtains the current marker through the existing `agentSession.currentRequests`
stale-version/restart contract. It joins every JSON piece and checks the session, epoch,
publisher, owner, revision, version, exact cursor movement, duplicate item IDs and pending
prompt schemas. Collection is bounded to three attempts, 64 pieces per attempt and one million
UTF-16 code units. A changed or incomplete view is refused; historical pending rows are never
substituted for the authoritative current list. Reads before and after collection also check
the runtime, workspace and session fence.

## One exact answer file

Copy the identities, marker and revision from the inspected result. Choose one offered approval
`optionId`, or supply structured question `answers`. Do not invent an option, rewrite a question
ID, trim typed answers or repurpose an operation UUID. The UTF-8 file is limited to 128 KiB and
rejects unknown top-level keys. Its required fields are:

```json
{
  "workspaceId": "repo-id::C:/projects/example",
  "sessionId": "chat_session_01",
  "expectedRuntimeId": "runtime-copied-from-list",
  "expectedRequests": {
    "contract": "agent-session.current-requests.v1",
    "sessionId": "chat_session_01",
    "epoch": "epoch-copied-from-list",
    "publisher": "11111111-1111-4111-8111-111111111111",
    "revision": 1,
    "owner": "owner-copied-from-list",
    "version": "22222222-2222-4222-8222-222222222222"
  },
  "itemId": "item-copied-from-list",
  "kind": "approval",
  "expectedRuntimeFence": 7,
  "expectedRevision": 1,
  "clientOperationId": "33333333-3333-4333-8333-333333333333",
  "optionId": "exact-offered-id"
}
```

For a question use `"kind": "question"` and replace `optionId` with:

```json
{
  "answers": [
    {
      "questionId": "exact-question-id",
      "optionIds": ["exact-offered-id"],
      "other": "An exact typed answer, only when that question permits one.\nNewlines are preserved."
    }
  ]
}
```

The shared native question schema and host validation decide which selections and free text
are permitted. Optional `turnItemId` binds the file to one journal turn. If `--turn` is also
passed, the values must match. All provider-offered options retain their original meaning,
including any broader scope described by a provider. The CLI adds no approve-all flags or
automatic approval policy. A UI relaying an option must disclose its actual scope to its user.

On an initial answer the CLI compares the runtime, workspace, session, complete marker, fence,
item revision, kind, and any turn restriction again. It computes `payloadFingerprint` with the
existing shared canonical fingerprint function. The host performs its existing lease,
current-provider ownership, question/option and revision checks. Newer hosts do not independently
enforce the envelope's expected fence: the CLI's initial comparison is distinct from those
host checks.

Answering also requires `runtime-source-fence.v1` and a host installation identity. The inspected
runtime and installation are carried in the existing `expectedRuntimeSource` wire field, which
the host checks before invoking any handler. This works on local sockets and paired sockets.
The pin is a separate transport argument, not part of the orchestration forwarding envelope.
Ordinary terminal/orchestration calls retain their existing behavior. Older hosts that would
ignore the pin are refused without mutation.

## Receipts, retries and unknown outcomes

A successful result says `outcome: "accepted"`, preserves the host receipt and its `replayed`
flag, and explicitly says `resumed: "unverified"`. It verifies the returned item, resolved
selection or exact answers, and revision before reporting acceptance. A durable answer may have
been committed before the provider connection failed. Acceptance is therefore not proof of
provider resumption or task completion; follow subsequent authoritative status separately.

After a lost response, inspect the session first. If deliberately replaying the same operation,
reuse the exact original file and pass its UUID:

```text
orca agent requests answer --worktree id:<workspaceId> --session <sessionId> --request-file answer.json --retry <same-operationUUID> --json
```

`--retry` must equal the file UUID. It sends that same native operation once and allows the
host's existing receipt-first replay even when the original prompt is no longer pending, its
marker changed or its fence advanced. Runtime, session and workspace must still match. The CLI
does not generate a fresh operation, retry automatically, choose another pending question or
claim that an unknown outcome failed. Explicit host refusals retain their code; uncertain
transport or mismatched receipts remain unknown. A closed tab whose workspace identity can no
longer be proved is refused even for replay.

No permission rejection, human-only platform requirement or unsupported native workflow is
bypassed by these commands. Update the execution host when its native contracts are missing.
