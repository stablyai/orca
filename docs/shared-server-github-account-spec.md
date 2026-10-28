# GitHub Accounts for Shared Runtime Participants

Status: implementation contract

Issue: https://github.com/stablyai/orca/issues/34822

Inspected baseline: `5237d52f8298604f425ef68e6e9281ea41c9d0e0`

## Goal

Two trusted collaborators connected to one Orca runtime can use different GitHub accounts for the same registered repository. One collaborator's account selection must not change another collaborator's requests or background work.

This feature selects credentials for Orca-managed GitHub operations. Git author/committer settings, branch prefixes, Git transport credentials, and arbitrary shell `gh` commands remain separate mechanisms.

## Existing authority

- `RpcCallerIdentity` proves a local owner process or a paired device, not a human account.
- `DeviceEntry` has no human subject. A client-provided participant name or ID cannot establish identity.
- Paired runtime clients already have terminal-equivalent host access and account administration. This feature cannot provide OS-level credential isolation between untrusted tenants.
- `Repo.ghAccount` currently holds one shared account binding.
- Unary RPC installs an authenticated caller in `rpc-active-caller.ts`. Streaming and background paths require separate review; ambient async context alone is not durable ownership.
- Workspace creator provenance serves presentation and visibility. Direct mobile calls can be represented as `host`, so it cannot substitute for authenticated participant ownership.

## Enrollment decision

The runtime owner creates a named participant and explicitly associates authenticated device grants and allowed GitHub accounts with that participant. Several devices may belong to one participant. Participant IDs are runtime-issued and cannot be self-asserted by request parameters. This enrollment model was confirmed by the user.

Orca Account sign-in is not required. The desktop profile's cloud user ID is not treated as the identity of incoming runtime RPC.

## Account resolution contract

1. Existing single-user behavior remains available when participant mode is not configured.
2. In participant mode, direct GitHub requests resolve the authenticated participant, the target repository, and that participant's allowed account binding.
3. Missing membership, missing binding, revoked account authorization, or an unavailable selected account produce an actionable error. They must not fall through to the shared Repo binding or ambient `gh` login.
4. Only the runtime owner assigns device membership or account authorization. A participant may select among accounts assigned to that participant, without editing another participant or the shared default.
5. A delegated phone follows its authenticated parent desktop's membership. An independently paired phone requires explicit enrollment.
6. Credential rotation retains the same authenticated device's membership. New device-key forks and re-pairing need an explicit membership policy.
7. Account selection uses existing short-lived credential resolution on the execution host. No global `gh auth switch`, stored tokens in project metadata, or caller-supplied raw tokens are introduced.

## Durable work and read results

- Persist a resolved participant owner when accepting workspace/session/job creation. Queued work must not consult whichever client is currently focused.
- Define background PR polling without a requesting participant explicitly. It must not select an arbitrary connected participant.
- Capture the selected account when accepting an operation; retries must preserve that selection and revalidate its authorization before another external operation.
- Revoking a device disconnects that device. Whether its already accepted background work continues under its participant is a separate lifecycle decision; it must not be inferred from a socket disconnect.
- Lower GitHub reads already expose `githubReadExecutionScope`. Preserve account information through intermediate wrappers and partition refresh/coalescing keys and delivery by the resolved identity.
- Account-specific results must not be written to a shared cache or broadcast as if they were valid for every participant.
- Raw local CLI calls cannot claim a participant through an ID flag alone. Agent calls need existing server-verifiable session ownership; otherwise they have only local owner authority or must be refused where an owner is required.
- A request carrying agent session or launch evidence is never promoted to owner because its member binding is absent. Normal owner shell commands without agent evidence remain the headless administration path.
- Member jobs reuse Orca's current terminal launch attestation or native structured-session writer proof. The accepted account is persisted privately and rechecked against current member grants. Old jobs with no accepted binding and unsupported cross-host proof are refused.
- Shared persisted GitHub cache and automatic PR broadcasting are withheld while any repository on the runtime enables participant mode. Explicit project queries remain available under the authenticated member; this conservative policy avoids presenting unscoped legacy cache entries as account-specific results.

## UI and compatibility

- Show the effective GitHub account and whether a control edits the participant binding or the shared project default.
- Show only accounts authorized for the participant on self-service account selection surfaces.
- Introduce a runtime capability for participant bindings. An old client must not silently mutate the shared fallback while the project is in participant mode.
- Resolve target repositories and bindings on the execution runtime, including native and WSL execution. Mobile uses the same authority contract.
- Folder contexts that expose GitHub operations need the same participant resolution even if they have no Git worktree.

## Implementation seams

| Concern                   | Existing code to extend or reuse                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| Authenticated caller      | `src/main/runtime/rpc/rpc-caller-identity.ts`, `device-entry.ts`, `device-registry.ts`       |
| Owner-only administration | `src/main/runtime/rpc/rpc-caller-scope.ts`, `rpc-method-permission.ts`                       |
| Request context           | `src/main/runtime/rpc/dispatcher.ts`, `rpc-active-caller.ts`, streaming dispatcher           |
| Repo GitHub execution     | `src/main/project-runtime-git-options.ts`, runtime GitHub query/mutation controllers         |
| Bound credentials         | `src/main/git/command-runner/gh-bound-account-env.ts`, `src/main/github/gh-account-token.ts` |
| Background refresh        | `src/main/github/pr-refresh-candidate-policy.ts`, refresh queue/coordinator and delivery     |
| Settings                  | `RepositoryGitHubAccountSection.tsx`, binding inventory/validation RPC contracts             |
| Durable owner             | Workspace/session/job creation and server-verifiable agent caller evidence                   |

## TDD acceptance cases

- Two concurrent authenticated participants read and mutate the same repository using distinct selected accounts; neither changes `Repo.ghAccount` or global `gh` state.
- Same repository/branch under two account scopes does not coalesce into one authenticated request or reuse another account's result.
- Participant self-service cannot select an unassigned account, modify another participant, or assert an arbitrary participant ID.
- Multiple explicitly associated devices use the same participant; unrelated devices and direct phones cannot inherit membership accidentally.
- A queued job keeps its accepted owner/account after disconnect, another client's navigation, restart, and retry; revoked or unresolved authority fails clearly.
- Missing account credentials never launch an alternate-account GitHub command.
- Old client/server operations reject unsupported participant mode before changing a shared binding.
- Existing unconfigured single-user operations, non-GitHub providers, and explicit shared-default administration retain their documented behavior.

## Verification boundary

Source discovery alone does not demonstrate multi-user behavior. Completion requires runtime-level concurrent-client tests with observable fake GitHub identities, focused persistence/revocation tests, repository checks, and hidden Electron CDP validation of the settings flow. A single Mac can run isolated client/server fixtures, but that is not a physical multi-machine test.
