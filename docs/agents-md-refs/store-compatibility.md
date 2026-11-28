# Store compatibility

A user who goes from this build back to the floor release, then forward again, must lose nothing: no lost, duplicated or reopened chats, tabs, attachments, settings or terminals, and no slow first launch.

**The floor** is the release named in `src/main/store-compatibility/fixtures/store-floor-release.ts`, normally the current stable. It is raised only at a release:

1. Run `node config/scripts/store-compatibility/write-floor-store-schemas.mjs v<release>`.
2. Point `STORE_FLOOR` at the new fixture and update its release, commit and versions.
3. Delete the old fixture.

That is the goal. The tests below prove part of it: the floor can open and write every store this build created or migrated, at the schema level, and can find this build's terminal daemon. They don't prove that rows survive a migration or that stored payloads keep their meaning; the review rules and each migration's own old-writer test cover those.

Anything here protects only downgrades to builds that already contain it. Rules this build follows on its own work against today's floor. Rules that make older builds tolerant only help once those builds are the floor.

## Enforced by `store-floor-compatibility.test.ts`

The profile state, chat journal, chat domain and orchestration stores are checked twice: created fresh by this build, and created by the floor and then opened by this build. Against the floor's shape:

- **Allowed:**
  - new tables;
  - new nullable or defaulted columns, except on a table the floor inserts into without a column list (`fixtures/<release>-positional-insert-tables.json`);
  - new non-unique indexes;
  - new tables' own triggers.
- **Forbidden:**
  - dropping a floor table, column or index;
  - changing a floor index under its name (give the new definition a new name; the floor recreates some indexes with `IF NOT EXISTS` and pins others with `INDEXED BY`);
  - changing a floor column's type, NOT NULL, default, primary key or generated expression (the floor reports the profile as damaged);
  - adding or removing `WITHOUT ROWID` or `STRICT` on a floor table;
  - adding a NOT NULL column with no default;
  - changing a CHECK constraint;
  - adding a UNIQUE index to a floor table (the floor's inserts start failing);
  - changing a floor trigger's body. Give the new body a new name: `IF NOT EXISTS` keeps whichever body was created first.
- **user_version** of the profile, chat journal and chat domain must equal the floor's. A newer one makes the floor refuse the profile and open chats read-only. Orchestration may be newer, because the floor writes it as is.
- **A trigger this build adds to a floor table** fires inside the floor's writes too. List it in `fixtures/reviewed-floor-table-triggers.json` with why it is safe. It must use only built-in SQL and never `RAISE`.
- **The chat record `schemaVersion`** must equal the floor's. Records with any other version are invisible to the floor.
- **The chat journal row version** must equal the floor's. The floor refuses rows with a higher version as newer and stops writing that chat.

`daemon-floor-hold.test.ts` checks discovery only: it doesn't start a daemon or connect a floor client. It keeps the floor able to find this build's terminal daemon by its pid record, socket path (including the Windows pipe hash and the short Unix path for long user-data folders), token name and command line. That way the floor shows this build's terminals read-only with Reopen, instead of restoring them a second time. Every protocol bump must keep it passing.

## Review rules

- **Rebuilding a floor table** (copy, drop, rename) passes the shape check, so it must keep every row, and every rowid other rows or the floor rely on.
- **A change that alters a floor-visible representation or how floor-written state is adopted** (a migration, writer, trigger, import or recovery path, or cleanup) ships an old-writer/old-reader test at the layer that owns the change. Seed literal historical rows (`writeFloorShapedStore` creates the store as the floor does), exercise the changed mechanism, run the floor's relevant operation, reopen with this build and assert literal results. Reopen a second time when a one-shot adoption or retirement is involved. Schema equality alone doesn't cover these.
- **Chat rows are read as plain JSON:** the floor reads the chat domain store (`journal_items`, `journal_queue_cards` and the rest) without strict checks, so a new optional key there is safe. Its strict readers, which treat an undeclared key or union tag as newer and stop writing that chat, run only when it imports the old chat journal file, which this build never writes. Data the floor must act on still needs a form it understands; data it would miss (a text tail it doesn't fold) waits behind a switch like `JOURNAL_TEXT_TAIL_WRITES` until the declaring release is the floor.
- **Fold before you can die:** data this build keeps only in tables the floor doesn't read must reach floor-visible rows before a crash can strand it, not only on clean quit.
- **Renames dual-write** the old key until the floor reads the new one. Example: `experimentalConnectors` -> `botsEnabled`.
- **Keep the floor's representations** for anything its cleanup acts on:
  - chat record rows in `agent_session_records`, because attachment claim pruning keys on them;
  - upload paths and sweep marks;
  - workspace key types and host kinds, because the startup workspace purge drops what it can't place;
  - persisted enum values (pane, tab and item kinds).
    New concepts go in new fields or tables beside the old ones.
- **One-shot markers** stay until the floor no longer writes the legacy form.
- **An Electron major bump** makes Chromium storage impossible to downgrade. Call it out in the release notes and raise the floor deliberately.

## Later options

- **A daemon that also speaks the floor's protocol on the floor's socket.** Only if running processes should survive a downgrade. Today the floor holds them read-only, and Reopen stops this build's daemon.
- **A read floor and a write floor per store**, so a newer store can stay writable by an older build that understands its changes.
