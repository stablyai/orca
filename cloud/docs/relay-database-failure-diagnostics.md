# Relay database failure phases

`orca_relay_postgres_query_failed` separates failure to acquire a pooled connection
(`phase=acquire`) from failure after acquisition (`phase=execute`). It covers
`PostgresDatabase.query`, including the single-statement control-renewal CTE.
Statements inside explicit transactions use a different query path and are not
covered. These events are diagnostic evidence, not a replacement for total SQL
failure counters.

The event contains only an allowlisted error code, a connection-timeout boolean,
a transient boolean, the operation category (`control-renewal` or `other`), total
elapsed milliseconds, and pool total/idle/waiting counts at failure. Total elapsed
time includes acquisition. An acquisition timeout can mean either waiting in the
queue or establishing a new connection; `connectionTimeout` covers both, and the
pool counts separate them: a queue wait has waiters, a dial does not.
Unknown error codes stay `unknown`.

`transient` is the classification the request routes act on, not a second
opinion: true means retryable, false means terminal. It is not a count of HTTP
responses. Every caller of `PostgresDatabase.query` emits this event, including
background sweeps, startup reconciliation, and admin routes that map a failure
to 409, and none of those produces a 503 or a 500. Counting `transient=false`
therefore over-counts user-facing hard failures; narrow by operation, or join
against the route's own rejection logs, before reading it that way. A pool that
cannot hand out a client carries no error code at all, so `code` stays `unknown`
for that whole class and only these two booleans separate it from a genuine
fault such as a rejected password.

Query text, parameters, error messages, and identifiers are never emitted.
Successful queries emit no additional event.

Use structured GCE logs with `jsonPayload.event="orca_relay_postgres_query_failed"`.
Compare counts by phase, operation, and code with the same cell's renewal outcomes
and pool pressure, and with independent PostgreSQL wait samples. Establishing the
failure phase does not by itself establish why the pool backed up.

For production observation, use an immutable image through the same-cap workflow
on one cell, with fresh monitor evidence and the exact predecessor digest. Verify
the serving digest and health, then inspect these events during a naturally
occurring failure. Do not deliberately induce a production database failure.
Rollback uses the same workflow and predecessor image; no schema or database
configuration changes are involved. Do not change rehome limits, timeouts, pool
sizes, or renewal scheduling merely to collect this evidence.
