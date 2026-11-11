import Database from '../sqlite/sync-database'

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
export function openCode1ForkStore(path: string) {
  const db = new Database(path)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
      seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);
    INSERT INTO session VALUES ('ses_e4d773f6affe3HGZP6SZo2NjZp', NULL);
    INSERT INTO session VALUES ('ses_e4d76d713ffe98vxcM3WaxWjVI', NULL);`)
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, 1, 1, ?)')
  insert.run('msg_1b288c688001YdJeVFY2Yyte5V', 'ses_e4d773f6affe3HGZP6SZo2NjZp', '{"role":"user"}')
  for (const [id, role] of [
    ['msg_1b28928ed001PfHNbepa2ju4PH', 'user'],
    ['msg_1b28928ee001wHBhq6QZzVGJ3f', 'assistant'],
    ['msg_1b28928f5001P7iHSIEED9Iq2p', 'user'],
    ['msg_1b28928f6001CkhDQSpYI3ByI4', 'user'],
    ['msg_1b28928f80012WtB5Unb6QBY2Y', 'assistant'],
    // Deliberately before capture: the accepted 1.x interval limitation covers this CLI root too.
    ['msg_1b2892ade0019IigeE4JneP9j3', 'user']
  ]) {
    insert.run(id!, 'ses_e4d76d713ffe98vxcM3WaxWjVI', JSON.stringify({ role }))
  }
  const part = db.prepare(
    "INSERT INTO part VALUES (?, ?, 'ses_e4d76d713ffe98vxcM3WaxWjVI', 1, 1, ?)"
  )
  part.run(
    'file-part',
    'msg_1b28928ed001PfHNbepa2ju4PH',
    '{"type":"file","url":"file:///image.png"}'
  )
  part.run('compaction-part', 'msg_1b28928f6001CkhDQSpYI3ByI4', '{"type":"compaction","auto":true}')
  return db
}
