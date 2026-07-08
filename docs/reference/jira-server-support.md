# Jira Server/Data Center Support

## Goal

Add Jira Server/Data Center support to Orca's existing Jira integration without
regressing Jira Cloud behavior. Target Jira Server/Data Center 9.x instances
first, using the REST API v2 surface those deployments expose.

This document is the implementation reference for the Jira Server/Data Center
support PR. It records the contribution constraints, repository boundaries, API
mapping, and verification plan that the implementation must satisfy.

## Single PR Scope

Land the core Server/DC feature in one PR. Internal commits may be split by
layer, but the final PR must include Server/DC support for all Jira capabilities
that Orca exposes today:

- Connect, test connection, disconnect, and status.
- List assigned issues and run custom JQL searches.
- Get issue details.
- Create issues, including project, issue type, description, and required create
  fields. Priority and labels are supported when Jira exposes them through create
  metadata/custom fields.
- Update supported issue fields: summary/title, labels, priority, assignee, and
  transition.
- Add and list comments.
- List projects, issue types, create fields, priorities, assignable users, and
  transitions.
- Assign, unassign, and transition issues.

Do not split a connect-only Server/DC PR from the remaining issue operations.
The contribution is only complete when Cloud and Server/DC both work across
local IPC and remote runtime paths.

## Pre-Change State

Orca's Jira integration is currently Jira Cloud oriented:

- Connection verification calls `/rest/api/3/myself`.
- Authorization is always Basic auth over `email:apiToken`.
- Issue operations use Cloud REST API v3 paths such as
  `/rest/api/3/search/jql`, `/rest/api/3/project/search`, and
  `/rest/api/3/issue/createmeta/...`.
- User identity is modeled around Cloud `accountId`.
- Create and comment bodies use Atlassian Document Format (ADF).
- The UI copy says "Jira Cloud site URL", "Atlassian email", and "API token".

Jira Server/DC 9.x exposes:

- `/rest/api/2/serverInfo` with `deploymentType: "Server"` or
  `"Data Center"` plus version information.
- `/rest/api/2/myself` as the authenticated Server/DC identity endpoint.
- `/rest/api/3/*` paths that redirect to `login.jsp` when unauthenticated and
  are not a reliable Server/DC integration surface.

## Constraints From Repository Contribution Docs

Implementation must follow the repository's contribution rules:

- Keep changes scoped and preserve macOS, Linux, and Windows support.
- Do not assume local-only execution; Jira must work through local and remote
  runtime paths.
- Keep provider-specific behavior behind explicit checks.
- For UI work, follow `docs/STYLEGUIDE.md`, use existing tokens, and use shadcn
  primitives from `src/renderer/src/components/ui/`.
- Do not add `max-lines` disables. Split Jira code into concrete, named modules
  when adding Server/DC behavior.
- Do not introduce vague module names such as `helpers`, `utils`, or `common`.
- Keep project-owned types in `.ts` files, not `.d.ts`.
- Do not log credentials or include PR evidence images in the repo.

## Non-Goals

- Do not replace the current Jira Cloud integration.
- Do not create a separate task provider named `jira-server`.
- Do not implement OAuth, SAML browser login, cookie-based auth, or interactive
  SSO flows.
- Do not migrate existing Cloud users to new credentials or force reconnect.
- Do not add GitHub-specific concepts to Jira task or review code.

## Architecture

Keep a single Jira provider in the UI and store, but route authenticated
operations through deployment-specific main-process adapters:

- `cloud`: existing Jira Cloud behavior using REST API v3 and `accountId`.
- `server`: Jira Server/Data Center behavior using REST API v2 and Server/DC
  user identifiers.

The renderer should not know endpoint details. It should pass a connection
payload, show the saved site metadata, and call the same Jira store/runtime
methods it calls today.

## Data Model

Extend the shared Jira site and connection types:

```ts
export type JiraDeploymentType = 'cloud' | 'server'
export type JiraAuthMode = 'basic' | 'bearer'

export type JiraSite = {
  id: string
  siteUrl: string
  email: string
  displayName: string
  accountId: string
  viewerUserId: string
  deploymentType: JiraDeploymentType
  authMode: JiraAuthMode
  authUsername?: string
}

export type JiraUser = {
  userId: string
  accountId: string
  displayName: string
  email?: string | null
  avatarUrl?: string
}

export type JiraCloudConnectArgs = {
  deploymentType?: 'cloud'
  siteUrl: string
  email: string
  apiToken: string
}

export type JiraServerBasicConnectArgs = {
  deploymentType: 'server'
  authMode: 'basic'
  siteUrl: string
  username: string
  passwordOrToken: string
}

export type JiraServerBearerConnectArgs = {
  deploymentType: 'server'
  authMode: 'bearer'
  siteUrl: string
  bearerToken: string
}

export type JiraConnectArgs =
  | JiraCloudConnectArgs
  | JiraServerBasicConnectArgs
  | JiraServerBearerConnectArgs

export type JiraIssueUpdate = {
  title?: string
  labels?: string[]
  priorityId?: string | null
  assigneeUserId?: string | null
  assigneeAccountId?: string | null
  transitionId?: string
}
```

Compatibility rules:

- Legacy callers may omit `deploymentType`; normalize those payloads to Cloud
  only at the IPC/RPC/store boundary before they reach the Jira client.
- Existing saved sites with no `deploymentType` are treated as `cloud`.
- Existing saved sites with no `authMode` are treated as `basic`.
- Existing Cloud site ids must remain stable.
- Server/DC site ids should be derived from
  `siteUrl + deploymentType + viewerIdentityId`, where
  `viewerIdentityId` is returned by the successful `/rest/api/2/myself` response.
  This avoids storing or hashing Bearer token material while still keeping
  multiple Server/DC users on the same site separate.
- Server/DC sites should keep the existing `email` field populated with
  `emailAddress ?? username ?? viewerUserId` for renderer compatibility, but UI
  labels should prefer `authUsername` when the site is Server/DC.
- Populate `viewerUserId` with the deployment-specific stable identity. Server/DC
  must not use mutable `displayName` as persisted identity. Keep `accountId`
  populated for backward compatibility, but treat it as a legacy alias outside
  Cloud-specific adapter code.
- Populate `JiraUser.userId` with the assignment-safe identity: Cloud
  `accountId`, or Server/DC `name`. Keep `JiraUser.accountId` as a deprecated
  alias so old Cloud-oriented call sites continue to render while they migrate.

The shared update shape must use `assigneeUserId` as the renderer-facing
assignee field. Keep `assigneeAccountId` as a deprecated compatibility alias for
existing Cloud callers until all call sites are migrated. Write adapters must
branch on deployment type rather than blindly sending either value as a Cloud
`accountId`.

## Authentication

### Cloud

Cloud keeps current behavior:

- Require `https://` before sending any credentials or auth headers.
- Required fields: `siteUrl`, `email`, `apiToken`.
- Header: `Authorization: Basic base64(email:apiToken)`.
- Verify: `GET /rest/api/3/myself`.
- Viewer id: `accountId`.

### Server/Data Center

Server/DC supports two explicit auth modes:

- Require `https://` before sending any credentials or auth headers.
- Basic: `Authorization: Basic base64(username:passwordOrToken)`.
- Bearer: `Authorization: Bearer <bearerToken>`.

Verification:

- Verify Basic and Bearer credentials with `GET /rest/api/2/myself`.
- Map viewer id from `key ?? name`.
  Reject Server/DC responses that provide no stable identity.
- Do not treat a 403 as token revocation. Keep the existing rule that only 401
  clears saved credentials.

Credential storage:

- Reuse the existing per-site token storage boundary.
- Store only the secret token/password in the encrypted token file.
- Store non-secret site metadata in `jira-sites.json`.
- Never write credential values to logs, telemetry, snapshots, or PR evidence.

## Deployment Detection

Connection should not rely on URL shape alone.

Implemented behavior:

1. Let the user pick `Cloud` or `Server/Data Center` in the connection dialog.
2. Treat the user selection as authoritative. This avoids relying on URL shape
   or unauthenticated probes that many private deployments block or redirect.
3. Validate the final selected deployment by calling that deployment's `/myself`
   endpoint.

Detection outcomes:

- `deploymentType === "cloud"` calls Cloud REST API v3.
- `deploymentType === "server"` calls Server/DC REST API v2.
- The credential verification endpoint decides success or failure.
- A future enhancement may add an optional `serverInfo` preflight, but this PR
  does not require it for correctness.

## File Structure

Split main-process Jira behavior into concrete modules instead of expanding the
original Jira files further:

- `src/main/jira/site-storage.ts`
  - Read, normalize, migrate, and write `jira-sites.json`.
  - Own token path construction and saved site filtering.
- `src/main/jira/auth-headers.ts`
  - Build Basic and Bearer auth headers.
  - Keep credential string handling in one small surface.
- `src/main/jira/jira-request.ts`
  - Own Electron `net.fetch`, proxy bridging, Jira error parsing, and shared
    authenticated request helpers.
- `src/main/jira/jira-user-identity.ts`
  - Map Cloud and Server/DC user objects into Orca's shared `JiraUser` shape.
  - Build deployment-specific assignee update payloads.
- `src/main/jira/issue-mappers.ts`
  - Map Jira issue, project, priority, status, comment, and create-field
    responses into shared Orca types.
- `src/main/jira/issue-rest-routing.ts`
  - Select REST API v2 or v3 paths from the saved deployment type.
- `src/main/jira/issue-page-fetcher.ts`
  - Share Jira pagination handling across comments and metadata reads.
- `src/main/jira/issue-search.ts`
  - List issues, run JQL searches, and fetch single issue details.
- `src/main/jira/issue-comments.ts`
  - Add and list comments while preserving Cloud ADF and Server/DC plain text
    behavior.
- `src/main/jira/issue-metadata.ts`
  - List projects, issue types, create fields, priorities, assignable users,
    and transitions.
- `src/main/jira/issues.ts`
  - Keep create/update issue mutations and re-export search, comment, mapper,
    and metadata methods from the focused modules.
- `src/main/jira/client.ts`
  - Keep concurrency, public connection methods, status, selection, and
    disconnect behavior.
  - Delegate storage, auth-header, and identity details to the focused modules
    above.

This split avoids new `max-lines` disables and gives each module one concrete
responsibility.

## Server/Data Center REST Mapping

Use Jira Server/Data Center REST API v2 for Server/DC sites.

| Operation | Server/DC endpoint | Notes |
| --- | --- | --- |
| Verify connection | `GET /rest/api/2/myself` | User id from `key` or `name`; never `emailAddress`, Basic username fallback, or `displayName`. |
| Search issues | `POST /rest/api/2/search` | Body: `{ jql, maxResults, fields }`. |
| Get issue | `GET /rest/api/2/issue/{key}?fields=...` | Same field list as Cloud where available. |
| Create issue | `POST /rest/api/2/issue` | Description and textarea create fields are plain text, not ADF. |
| Update issue fields | `PUT /rest/api/2/issue/{key}` | Summary, labels, priority map similarly. |
| Assign issue | `PUT /rest/api/2/issue/{key}/assignee` | Body: `{ name: userName }` or `{ name: null }`. |
| Transitions | `POST /rest/api/2/issue/{key}/transitions` | Same transition id shape. |
| Add comment | `POST /rest/api/2/issue/{key}/comment` | Body: `{ body: string }`. |
| List comments | `GET /rest/api/2/issue/{key}/comment?...` | Response uses `comments`. |
| List projects | `GET /rest/api/2/project` | Response is usually an array, not `{ values }`. |
| List issue types | `GET /rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes?...` | Use the Jira 9.x replacement endpoint. |
| List create fields | `GET /rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}?...` | Use the Jira 9.x replacement endpoint. |
| List priorities | `GET /rest/api/2/priority` | Response is an array. |
| Assignable users | `GET /rest/api/2/user/assignable/search` | Use `issueKey` for edit-time lookups, `project` for create-time lookups, plus `username` and `maxResults`; do not send Cloud `query`. |

Do not use the removed aggregate `GET /rest/api/2/issue/createmeta` endpoint for
Jira 9.x Server/DC support.

## Cloud REST Mapping

Keep existing Cloud REST API v3 behavior:

- Search: `POST /rest/api/3/search/jql`.
- Project list: `GET /rest/api/3/project/search`.
- Issue type metadata:
  `/rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes`.
- Create fields:
  `/rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}`.
- Assignable users: `/rest/api/3/user/assignable/search?issueKey=...&query=...`.
- Assignee update body: `{ accountId }`.
- Description and comments: ADF documents.

Cloud tests should assert these paths remain unchanged.

## User Identity Rules

Use the exported deployment-aware user types as the identity layer:

```ts
export type JiraViewer = {
  userId: string
  accountId: string
  displayName: string
  email: string | null
  avatarUrl?: string
}

export type JiraUser = {
  // userId is deployment-specific; accountId remains as a deprecated
  // Cloud-era alias for legacy renderer callers.
  userId: string
  accountId: string
  displayName: string
  email?: string | null
  avatarUrl?: string
}
```

Mapping:

- Cloud `userId`: `accountId`.
- Server/DC viewer `userId`: `key ?? name`.
- Server/DC assignable-user `userId`: `name` only, because assignment writes the
  value back as `{ name }`.
- Keep `JiraUser.accountId` equal to `userId` for Server/DC until all renderer
  call sites stop relying on the legacy property name.
- Server/DC assignment payload:
  - If clearing assignee: `{ name: null }`.
  - If assigning:
    `{ name: updates.assigneeUserId !== undefined ? updates.assigneeUserId : updates.assigneeAccountId }`.
    The value must come from a Server/DC user `name`, not `key`, `emailAddress`,
    or `displayName`.
- Cloud assignment payload:
  - If clearing assignee: `{ accountId: null }`.
  - If assigning:
    `{ accountId: updates.assigneeUserId !== undefined ? updates.assigneeUserId : updates.assigneeAccountId }`.

Renderer-facing code should read and write the opaque `assigneeUserId` field.
Migrate `JiraIssueWorkspace.tsx` mutations from `assigneeAccountId` to
`assigneeUserId`, using `user.userId` from assignable-user results. Keep the
deprecated alias only to protect older runtime or store callers during the
transition. Main-process adapters must never assume a renderer-provided assignee
id is a Cloud `accountId` unless the site is Cloud.

## Description And Comment Format

Cloud:

- Continue converting text to ADF with `textToAdf`.
- Continue rendering ADF to Markdown with `adfToMarkdownText`.

Server/DC:

- Send plain text strings for description and comments.
- Send plain text strings for textarea create fields.
- Accept both string bodies and ADF-like objects when reading. The existing
  renderer of Jira body content already handles string input.

## UI Design

Update Jira connection UI in one reusable component:

- Reuse `JiraConnectDialog` for Settings, onboarding, and Tasks.
- Replace the duplicate inline Jira connect form in `TaskPage` with
  `JiraConnectDialog`.
- Add a deployment type segmented control:
  - `Cloud`
  - `Server/Data Center`
- Cloud mode fields:
  - Jira Cloud site URL.
  - Atlassian email.
  - API token.
- Server/DC mode fields:
  - Jira site URL.
  - Auth mode: `Username + password/PAT` or `Bearer PAT`.
  - Username and password/token for Basic.
  - Bearer token for Bearer.

Copy rules:

- Do not say Orca supports only Cloud after this change.
- Do not call Server/DC credentials an Atlassian Cloud API token.
- Explain credential storage using the existing local/remote runtime wording.
- Keep errors factual: for example, "Jira Server rejected these credentials" or
  "This Jira site did not respond to the selected deployment type."

Style rules:

- Use existing `Dialog`, `Input`, `Label`, `Button`, and select/segmented
  primitives.
- Use existing color tokens only.
- Keep form controls compact and aligned with Settings form conventions.
- Verify light/dark mode and remote latency behavior.

## IPC, Preload, Store, And Remote Runtime

Every connection argument and shared type change must cross all Jira boundaries:

- `src/shared/jira-types.ts`
- `src/preload/api-types.ts`
- `src/preload/index.ts`
- `src/main/ipc/jira.ts`
- `src/main/runtime/rpc/methods/jira.ts`
- `src/main/runtime/orca-runtime.ts`
- `src/renderer/src/runtime/runtime-jira-client.ts`
- `src/renderer/src/store/slices/jira.ts`
- `src/renderer/src/components/JiraIssueWorkspace.tsx`
- `src/renderer/src/components/TaskPage.tsx`

Remote runtime behavior:

- When active runtime is remote, connection credentials must be sent to the
  selected runtime and stored there, as today.
- Status, test connection, issue reads, mutations, metadata reads, and comments
  must behave identically through local IPC and runtime RPC.
- `src/main/runtime/orca-runtime.ts` must expose the same Server/DC-aware Jira
  bridge methods as local IPC, including connect, list/search, create, comments,
  assignee, and transitions.
- Zod RPC schemas must accept Cloud and Server/DC connect payloads and reject
  malformed mixed-mode payloads.

## Error Handling

- Keep only-401-clears-token behavior.
- Surface 403 as permission or endpoint access denial, not as disconnected.
- For "all sites" fan-out, preserve current partial-success behavior.
- For a selected single site, surface Server/DC adapter errors with status code
  context where available.
- If optional deployment probing is added later and fails, `/myself` should
  remain the authoritative connection check for the selected mode.
- If `/myself` returns HTML from a login redirect, report a clear selected-mode
  mismatch or authentication failure instead of a JSON parse error.

## Migration

Implement migration in `site-storage.ts`:

1. Read existing `jira-sites.json`.
2. Normalize each site.
   - Remove embedded `username:password@` credentials, query strings, and hashes
     from `siteUrl` before writing it back to disk.
3. For sites without `deploymentType`, write `deploymentType: "cloud"`.
4. For sites without `authMode`, write `authMode: "basic"`.
5. Preserve existing `id` for Cloud sites so token filenames keep working.
6. Drop only malformed sites or sites with missing token files, matching current
   behavior.

Server/DC sites are only created by the new connection flow, so no old Server/DC
site migration is needed.

## Testing Plan

### Main Jira Client

Add or update `src/main/jira/client.test.ts`:

- Existing Cloud site files migrate to `deploymentType: "cloud"` without
  changing site id or token path.
- Cloud connect still calls `/rest/api/3/myself` with
  `Basic base64(email:apiToken)`.
- Server Basic connect calls `/rest/api/2/myself` with
  `Basic base64(username:passwordOrToken)`.
- Server Bearer connect calls `/rest/api/2/myself` with `Bearer <token>`.
- Server/DC viewer maps `key` or `name` into the stored user id, and rejects
  responses with no stable identity.
- Server/DC connect reports an HTML `/myself` login redirect as a sanitized
  selected-mode or credential failure, not as a JSON parse error, and does not
  save a connected site.
- 403 is not treated as auth revocation; 401 is.

### Issue Operations

Add or update `src/main/jira/issues.test.ts` and new adapter tests:

- Cloud paths and request bodies remain unchanged.
- Server search uses `POST /rest/api/2/search`.
- Server create sends plain text `description`.
- Server required textarea create fields send plain strings, while Cloud keeps
  sending ADF documents for textarea create fields.
- Server comments send `{ body: string }`.
- Server project list handles direct array responses from `/rest/api/2/project`.
- Server issue type list uses
  `/rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes`.
- Server create fields use
  `/rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}`.
- Server edit-time assignable-user lookups send `issueKey`, `username`, and
  `maxResults`, not Cloud `query`; create-time lookups must use `project`
  instead of `issueKey`.
- Server assignee update sends `{ name }` or `{ name: null }`.
- Server user mapping preserves display name, email, and avatar where present.

### IPC And Runtime RPC

Add or update:

- `src/main/ipc/jira.test.ts`
- `src/main/runtime/rpc/methods/jira.test.ts`
- `src/renderer/src/runtime/runtime-jira-client.test.ts`

Coverage:

- Cloud connect payload validates.
- Server Basic connect payload validates.
- Server Bearer connect payload validates.
- Mixed payloads fail with a useful error.
- Runtime RPC forwards deployment and auth mode fields unchanged.
- The Orca runtime bridge keeps forwarding Server/DC-aware Jira calls for
  connect, status, list/search, create, comment, assign, and transition.

### Renderer Store And UI

Add or update:

- `src/renderer/src/store/slices/jira.test.ts`
- `src/renderer/src/components/jira-connect-dialog.test.tsx`
- `src/renderer/src/components/settings/jira-integration-card.test.tsx`

Coverage:

- Connect dialog switches between Cloud and Server/DC fields.
- Settings card copy no longer claims that Jira support is limited to Cloud.
- Successful connect refreshes status and clears stale Jira issue/search caches.
- Failed connect surfaces inline error text.
- `JiraIssueWorkspace` sends `assigneeUserId` for assign and unassign
  mutations and uses `user.userId` from assignable users. This path is
  typechecked and included in manual validation because this component does not
  currently have a dedicated component-test harness.
- There is no duplicate connect form behavior between Settings and TaskPage.

### Optional E2E

Only add E2E coverage if DOM behavior cannot be covered with component tests.
If adding E2E tests:

- Use `pnpm run test:e2e` for the default path.
- For fast iteration, build with `pnpm exec electron-vite build --mode e2e`
  before using `SKIP_BUILD=1`.
- Use `window.__store` only for setup.
- Final assertions must target user-visible DOM.

## Verification Commands

Run focused tests while implementing:

```bash
pnpm vitest run --config config/vitest.config.ts src/main/jira/client.test.ts src/main/jira/issues.test.ts
pnpm vitest run --config config/vitest.config.ts src/main/ipc/jira.test.ts src/main/runtime/rpc/methods/jira.test.ts
pnpm vitest run --config config/vitest.config.ts src/renderer/src/runtime/runtime-jira-client.test.ts src/renderer/src/store/slices/jira.test.ts
pnpm vitest run --config config/vitest.config.ts src/renderer/src/components/jira-connect-dialog.test.tsx src/renderer/src/components/settings/jira-integration-card.test.tsx
```

Run full contribution checks before opening a PR:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Manual Validation

Use a non-production or low-risk Jira Server/DC account when possible.

Server/DC manual checks:

1. Connect to a Server/DC URL with Basic auth.
2. Connect to a Server/DC URL with Bearer PAT if available.
3. Verify Settings shows the connected Server/DC site.
4. List assigned issues.
5. Run a custom JQL search.
6. Open an issue detail view.
7. Add a comment.
8. Create an issue with required custom fields.
9. Assign and unassign an issue.
10. Transition an issue.

Cloud regression checks:

1. Connect to an Atlassian Cloud site.
2. List, search, create, comment, assign, and transition issues.
3. Confirm ADF description/comment behavior remains unchanged.

Remote runtime checks:

1. Configure a remote runtime.
2. Connect Jira Server/DC while remote runtime is active.
3. Confirm credentials are stored by the remote runtime.
4. List and search issues through the remote runtime.
5. Create, comment, assign, unassign, and transition issues through the remote
   runtime.

## Security Review Checklist

- Credentials never appear in logs, telemetry, traces, screenshots, or thrown
  error messages.
- Basic and Bearer auth headers are built only in main/runtime code.
- Renderer receives saved metadata but never receives stored token contents.
- Server/DC password/PAT fields use password inputs.
- RPC schemas reject malformed auth payloads.
- Redirected HTML login pages produce sanitized error messages.
- Remote runtime credential storage copy remains accurate.

## PR Checklist

In the PR description:

- Summarize user-visible behavior: Jira integration supports Cloud and
  Server/Data Center sites.
- Include screenshots or a screen recording for the updated connect dialog.
- Include test evidence for focused Jira tests and full repo checks.
- In the AI Review Report, explicitly cover cross-platform support,
  SSH/remote/local runtime behavior, Jira Cloud regression risk, Server/DC auth,
  performance, UI quality, and provider compatibility.
- In the Security Audit, cover credential handling, auth headers, path handling,
  IPC/RPC validation, and logging.

## References

- Jira Server/Data Center REST API 9.17.0:
  <https://docs.atlassian.com/software/jira/docs/api/REST/9.17.0/>
- Jira REST API examples and create metadata replacement notes:
  <https://developer.atlassian.com/server/jira/platform/jira-rest-api-examples/>
