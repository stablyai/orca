# GitHub work-item pagination across repositories

Issue: [#12127](https://github.com/stablyai/orca/issues/12127)

## Problem

Tasks combines issues and pull requests from several repositories. Fetching
each repository independently loses the global Search API order, makes page
counts depend on renderer assumptions, and can drop rows between pages.

## Design

Resolve every selected repository before searching. Group sources only when they
share GitHub host, connection, and execution context. Each compatible group
uses one Search API request plan with one or more queries. Each query uses
multiple `repo:` qualifiers, existing task filters, and
`sort=created&order=desc`. Repository qualifiers are split only at repository
boundaries when the encoded request exceeds the 7,500-byte safety budget.

The measured qualifier experiment on issue #12127 accepted 288 real public
repositories before request-size failures appeared. The implementation uses
encoded-byte budgeting instead of a fixed qualifier count because Enterprise
hosts, proxies, and repository names vary.

## Pagination and limits

Grouped results are merged in Search API creation order. Pull-request detail
hydration is limited to four workers and grouped Search API calls share the
main GitHub semaphore. GitHub's first-1,000-result Search API window is exposed
as `searchWindowLimited` with a reachable count, so the renderer does not
advertise pages it cannot fetch.

Selections are capped at 256 repositories at the IPC/RPC boundary. Oversized
queries return classified validation metadata and a user-facing narrowing
message instead of looking like an empty search.

## Failure behavior

Repository resolution uses partial success. A stale selector or one failed
source does not erase results from valid repositories. The result carries
failed-source counts and classified error types. Grouped rows populate the
existing per-repository cache, including resolved source metadata, so dialogs,
source indicators, and edits see the same data as the list.

## Testing contract

Tests cover request-byte encoding, qualifier quoting and chunking, repository
names equal to `repos`, missing creation timestamps, grouped partial failures,
Search API window accounting, resolver partial success, hydration failures,
renderer cache population, and grouped fallback paths.
