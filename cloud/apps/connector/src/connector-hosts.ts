import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { ConnectorHelloRequest } from '@orca-cloud/connector-contract'
import type { ConnectorInbox } from './connector-inbox.js'

// Coarse on purpose: last-seen is written at most once a minute per host.
const LAST_SEEN_RESOLUTION_MS = 60_000

// Every machine request and queueing take this, so a newer hello lands wholly before or after each.
export async function lockConnectorHost(transaction: CloudDatabase, hostId: string): Promise<void> {
  await transaction.lockQuotaScope(`orca-connector-host:${hostId}`)
}

// A host is one machine of one account, (sub, mid) from its token; its first hello records it.
export class ConnectorHosts {
  constructor(
    private readonly database: CloudDatabase,
    private readonly inbox: ConnectorInbox,
    private readonly now: () => number
  ) {}

  // Under the host lock. The highest revision wins (a delayed older hello changes nothing); held polls
  // wake to find theirs stale, the next poll lists what was received but never settled, and a new
  // revision restarts the events mark.
  async recordHello(
    transaction: CloudDatabase,
    host: { hostId: string; accountId: string },
    hello: ConnectorHelloRequest
  ): Promise<void> {
    const now = this.now()
    const [recorded] = await transaction.query(
      `INSERT INTO connector_hosts
       (host_id, account_id, host_name, platform, runtime, orca_version, hello_rev, hello,
        unsettled_due, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (host_id) DO UPDATE SET host_name = excluded.host_name,
         platform = excluded.platform, runtime = excluded.runtime,
         orca_version = excluded.orca_version, hello_rev = excluded.hello_rev,
         hello = excluded.hello, unsettled_due = 1, last_seen_at = excluded.last_seen_at,
         events_seq = CASE WHEN connector_hosts.hello_rev = excluded.hello_rev
           THEN connector_hosts.events_seq END
       WHERE connector_hosts.hello_rev <= excluded.hello_rev`,
      [
        host.hostId,
        host.accountId,
        hello.hostName,
        hello.platform,
        hello.runtime,
        hello.orcaVersion,
        hello.helloRev,
        JSON.stringify(hello),
        now,
        now
      ]
    )
    if (Number(recorded?.changes ?? 0) > 0) {
      await this.inbox.wake(transaction, host.hostId)
    }
  }

  // Under the host lock: a request's hello is the machine's current one, an older one, or one the
  // cloud has no record of (the machine must send it).
  async helloStatus(
    transaction: CloudDatabase,
    hostId: string,
    helloRev: number
  ): Promise<'current' | 'older' | 'unknown'> {
    const [row] = await transaction.query(
      'SELECT hello_rev FROM connector_hosts WHERE host_id = ?',
      [hostId]
    )
    const current = row ? Number(row.hello_rev) : null
    if (current === helloRev) {
      return 'current'
    }
    return current !== null && helloRev < current ? 'older' : 'unknown'
  }

  // Under the host lock: true once per hello, for the poll that lists unsettled deliveries.
  async takeUnsettledDue(transaction: CloudDatabase, hostId: string): Promise<boolean> {
    const [taken] = await transaction.query(
      'UPDATE connector_hosts SET unsettled_due = 0 WHERE host_id = ? AND unsettled_due = 1',
      [hostId]
    )
    return Number(taken?.changes ?? 0) > 0
  }

  async accountOf(transaction: CloudDatabase, hostId: string): Promise<string | null> {
    const [row] = await transaction.query(
      'SELECT account_id FROM connector_hosts WHERE host_id = ?',
      [hostId]
    )
    return row ? String(row.account_id) : null
  }

  // Under the host lock, for the current hello: events apply only above its high-water mark, so a
  // late original never undoes newer state.
  async advanceEventsSeq(transaction: CloudDatabase, hostId: string, seq: number): Promise<boolean> {
    const [advanced] = await transaction.query(
      `UPDATE connector_hosts SET events_seq = ?
       WHERE host_id = ? AND (events_seq IS NULL OR events_seq < ?)`,
      [seq, hostId, seq]
    )
    return Number(advanced?.changes ?? 0) > 0
  }

  async touch(hostId: string): Promise<void> {
    const now = this.now()
    await this.database.query(
      `UPDATE connector_hosts SET last_seen_at = ?
       WHERE host_id = ? AND last_seen_at < ?`,
      [now, hostId, now - LAST_SEEN_RESOLUTION_MS]
    )
  }
}
