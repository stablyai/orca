# Relay database failure phases

`orca_relay_postgres_query_failed` separates failure to acquire a pooled connection
(`phase=acquire`) from failure after acquisition (`phase=execute`). It covers
`PostgresDatabase.query`, including the single-statement control-renewal CTE.
Statements inside explicit transactions use a different query path and are not
covered. These events are diagnostic evidence, not a replacement for total SQL
failure counters.

The event contains only an allowlisted error code, a connection-timeout boolean,
the operation category (`control-renewal` or `other`), total elapsed milliseconds,
and pool total/idle/waiting counts at failure. Total elapsed time includes acquisition.
An acquisition timeout can mean either waiting in the queue or establishing a new
connection; use the pool counts and independent server activity to distinguish them.
Unknown error codes stay `unknown`. Query text, parameters, error messages, and
identifiers are never emitted. Successful queries emit no additional event.

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
