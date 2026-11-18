# Store compatibility

A user who goes from this build back to the floor release, then forward again, must lose nothing: no lost, duplicated or reopened chats, tabs, attachments, settings or terminals, and no slow first launch.

**The floor** is the release named in `src/main/store-compatibility/floor/store-floor-release.ts`, normally the current stable. It is raised only at a release:

1. Run `node config/scripts/store-compatibility/write-floor-store-schemas.mjs v<release>`.
2. Point `STORE_FLOOR` at the new fixture and update its release, commit and versions.
3. Delete the old fixture.

Anything here protects only downgrades to builds that already contain it. Rules this build follows on its own work against today's floor. Rules that make older builds tolerant only help once those builds are the floor.

## Enforced by `store-floor-compatibility.test.ts`

The profile state, chat journal, chat domain and orchestration stores are checked twice: created fresh by this build, and created by the floor and then opened by this build. Against the floor's shape:

- **Allowed:**
  - new tables;
  - new nullable or defaulted columns;
  - new non-unique indexes;
  - new tables' own triggers.
- **Forbidden:**
  - dropping or rebuilding a floor table, column or index;
  - changing a floor column's type, NOT NULL, default or primary key (the floor reports the profile as damaged);
  - adding a NOT NULL column with no default;
  - changing a CHECK constraint;
  - adding a UNIQUE index to a floor table (the floor's inserts start failing);
  - changing a floor trigger's body. Give the new body a new name: `IF NOT EXISTS` keeps whichever body was created first.
- **user_version** of the profile, chat journal and chat domain must equal the floor's. A newer one makes the floor refuse the profile and open chats read-only. Orchestration may be newer, because the floor writes it as is.
- **A trigger this build adds to a floor table** fires inside the floor's writes too. List it in `floor/reviewed-floor-table-triggers.json` with why it is safe. It must use only built-in SQL and never `RAISE`.
- **The chat record `schemaVersion`** must equal the floor's. Records with any other version are invisible to the floor.

`daemon-floor-hold.test.ts` keeps the floor able to find this build's terminal daemon by its pid record, socket and token names, and command line. That way the floor shows this build's terminals read-only with Reopen, instead of restoring them a second time. Every protocol bump must keep it passing.

## Review rules the tests can't see

- **Strict chat storage:** declare first, write later. The floor treats a journal row with an undeclared key or union tag as newer and stops writing that chat. Ship the declaration and reader in one release, and write the field only once that release is the floor. Gate writes with a switch like `JOURNAL_TEXT_TAIL_WRITES` or `JOURNAL_STORED_OUTPUT_WRITES`.
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
