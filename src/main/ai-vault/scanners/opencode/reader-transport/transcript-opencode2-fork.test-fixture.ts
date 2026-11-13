import Database from '../../../../sqlite/sync-database'

// OpenCode 2.0.21 M1: copied seqs keep a fresh prefix; the event table is empty.
export function openCode2ForkStore(path: string) {
  const db = new Database(path)
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
      seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT, type TEXT, seq INTEGER);
    INSERT INTO session_v2 VALUES ('ses_e4d7a0c31ffejclsdjiiDszHMB', NULL, NULL, NULL);
    INSERT INTO session_v2 VALUES ('ses_e4d797526ffee7BYM6ri3gpmbg', NULL,
      'ses_e4d7a0c31ffejclsdjiiDszHMB', '{"type":"through","messageID":"msg_1b2868a8e0026IQTGMmj77bBFi"}');`)
  const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const [session, user, idle] of [
    [
      'ses_e4d7a0c31ffejclsdjiiDszHMB',
      'msg_1b285f9e10016X0Hu1rKOHAACe',
      'msg_1b2868a8e0026IQTGMmj77bBFi'
    ],
    [
      'ses_e4d797526ffee7BYM6ri3gpmbg',
      'msg_1b2868ada001HhsJYcY0OtPOjp_4',
      'msg_1b2868ada001HhsJYcY0OtPOjp_87'
    ]
  ]) {
    insert.run(
      user!,
      session!,
      'user',
      4,
      JSON.stringify({ files: [{ uri: 'file:///image.png' }] }),
      1,
      1
    )
    insert.run(idle!, session!, 'idle', 87, '{"outcome":"succeeded"}', 1, 1)
  }
  // Match copied timestamps deliberately: time is not provenance.
  insert.run(
    'msg_1b2868b430019orGpEpk0E3liv',
    'ses_e4d797526ffee7BYM6ri3gpmbg',
    'user',
    90,
    '{"text":"CLI after fork"}',
    1,
    1
  )
  return db
}

// OpenCode 1.19.5 M1: regenerated message IDs and empty newer-schema tables.
