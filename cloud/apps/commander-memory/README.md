# Commander account memory

Run with Node 24 on the account service host. Configure `ORCA_AUTH_CAPABILITIES_ENDPOINT` to the trusted Orca desktop capabilities endpoint, set `ORCA_COMMANDER_MEMORY_DB` to a persistent local SQLite path, and run `node server.mjs`. Route the account service's HTTPS path `/v1/commander/memory` to the loopback listener (default port 8785). A reverse proxy should preserve Authorization and disable caching. Back up SQLite with its backup API or a consistent snapshot including the WAL. SQLite supports a single host, including multiple processes sharing its local database.

The service verifies an Orca account bearer on every account request by posting an empty JSON object to the configured authority. Successful authentication must return `cloud.userId`, with optional `cloud.activeOrgId`. Two devices signed into the same account and organization share pages. Missing cloud identity, refused credentials or an unavailable authority fail closed. Access tokens stay out of the database.

| Method | Path below the service root | Result |
| --- | --- | --- |
| GET | / | Latest revisions, including tombstones, in `pages`. |
| GET | /index | The account owner reads up to 50 latest page summaries, project identifiers and a continuation cursor in `{pages,projects,next}`. |
| GET | /handoffs-index | The owner reads the same paged summaries, restricted to active handoffs with readable progress and next-step sections. |
| GET | /worker-guidance?projectId=… | The owner reads current human guidelines for the account and selected project in `{guidelines,truncated}`. |
| GET | /pages/:id | Current `page` and up to 25 newest-first revisions in `history`. Pass `?beforeVersion=<nextBeforeVersion>` for the next slice; a null cursor marks the end. |
| POST | /human | Account-authored revision. |
| POST | /delegations | With the account bearer, send `{type,id,projectId}` for an agent or commander and receive a project-scoped `token` and `expiresAt`. |
| POST | /agent or /commander | A worker uses its delegated token on the matching route. |
| GET | /preferences/settings | The account owner reads `{enabled,version}` for the current account and organization. |
| POST | /preferences/settings | The account owner sends `{enabled,expectedVersion}` and receives the saved settings. An outdated version that would change the current setting returns HTTP 409. |
| POST | /preferences/ask | A delegated worker submits `{question, requestId}`. Optional `expectedProjectId` and `expectedActorType` assertions check the credential’s project and role before lookup or replay. |

A bearer delegation lasts 15 minutes. The service stores only its hash. Account tokens should stay with the trusted desktop or runtime. Provision worker tokens only to the process that owns the delegated identity. Workers can read their project's pages and account-wide human decisions and guidelines, and write notes or decisions under their own identity in that project. Only the account may write guidelines, edit another author's pages or delegate. A human edit to a worker's page takes over further edits.

A write body contains `pageId`, `kind` (guideline, decision or note), `title`, Markdown `body`, optional `projectId`, optional `links` (page IDs), `expectedVersion` and `requestId`. Identifiers for pages and requests use up to 128 letters, digits, dots, underscores or hyphens and begin with a letter or digit. New pages use expected version zero. A successful request returns the new revision in `page`. The exact same edit and request ID replay the original result. A reused ID with different content or a stale version returns HTTP 409. Reload before applying a new edit. Kind and project are immutable for each page. Audit fields are assigned by the server from authenticated identities.

Send `{pageId,requestId,expectedVersion,deleted:true}` to append a tombstone. Full writes restore a tombstoned page; prior revisions remain available. History contains the data prior to deletion. The account database is independent of a session transcript and contains no Git worktree snapshots. Deploying this service and routing the account origin are operator steps.

To record a recurring preference, create a project guideline titled exactly `Recurring answer`. Its body is a JSON object such as `{"version":1,"question":"Which suite should I run?","answer":"Run the unit tests."}`. Questions allow up to 500 UTF-16 code units and answers allow 2,000. Both require text with no leading or trailing whitespace.

Recurring answers start off for each account and organization, including existing accounts upgrading the service. Its initial settings are `{"enabled":false,"version":0}`. Enabling them applies to all projects in that account and organization. While turned off, a valid worker ask returns `{matched:false,reason:"disabled"}`, including for previous matches. Rules and historical decisions stay in Memory. Once re-enabled, retrying a previous match returns its recorded decision, and retrying a question first asked while off evaluates the current rules.

With recurring answers enabled, one active, human-authored rule matching the worker's exact question in its project gives `{matched:true,answer,rulePageId,ruleVersion,decisionPageId}`. The linked decision records the worker, question, answer and rule revision. These system-issued decision pages have `recurringAnswerReceipt: true` and are immutable. The response for zero or multiple matches is `{matched:false,reason:"missing"}` or `{matched:false,reason:"conflict"}`. Each request ID replays its original result for the same account, organization, project and worker. Use a new ID to ask again after editing or deleting a rule. A different question with the same scoped request ID returns HTTP 409. This endpoint records workflow preferences. A tool's native approval still goes through that tool.

Run `node --test memory.test.mjs` for an offline integration test using a loopback identity authority and temporary database.

## Browsing large accounts

`GET /index` sorts by page ID by default. Pass `order=recent` for newest revisions first. Send the returned `next` value as the URL-encoded `after` parameter for the next batch, retaining the ordering and filters. A null cursor marks the last batch. The index shows the current state on each request. Refresh the first batch to see recent changes. Open `/pages/:id` for the full text, links and revision history.

Optional filters include `projectId`, `kind` (guideline, decision or note), `handoffsOnly=true`, `recurringOnly=true`, and `q` for a case-insensitive substring search across current content and attribution. Include tombstones with `includeDeleted=true`. The project selector covers all account projects with visible pages, independently of pagination and filters. Add `includeDeletedProjects=true` to include projects whose last page was deleted. Request specific summaries with up to 50 repeated `id` parameters. A directly paired phone makes requests through the authorized desktop.

The service builds the SQLite index transactionally on first startup with an existing database. Other writers may wait during this initial migration. Subsequent revisions, including receipts and writes from earlier service versions, update the index in the same transaction as the underlying page.


`/handoffs-index` applies the saved handoff format and section limits before pagination, including after someone edits a handoff in the wiki. It accepts the same filters, sorting and cursors as `/index`. Older clients can continue using the `handoffsOnly` header filter on `/index`.

Worker guidance is packed in page ID order within 8,000 UTF-16 code units, counting each title, version, body and separator. An entry that exceeds the remaining budget sets `truncated` to true. Later entries can still fit. The response excludes recurring-answer rules and deleted guidelines. Clients connecting to a .7 or .8 Memory service use its authenticated owner list for compatibility. Upgrade the service to receive bounded responses for both browsing handoffs and preparing worker guidance.
