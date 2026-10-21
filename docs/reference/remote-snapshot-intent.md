# Snapshots never carry intent

A client and a host exchange two kinds of payload: a **snapshot** (the whole state as the sender
sees it now, such as a pane layout) and a **delta** (what the user just did). They update
independently, so a snapshot may be resent, replayed or reordered by either side.

The rule: a snapshot never carries intent. Anything the receiver should treat as a user's action
travels as an explicit, optional delta field that names exactly what changed.

- A tag on the whole snapshot ("this push was a gesture") can't say which part of it the user
  changed, so the receiver either ignores it or applies it to fields the user never touched.
- An optional delta field is safe for older peers: one that doesn't know it drops it and keeps
  today's snapshot behaviour.

Example: `session.tabs.updatePaneLayout` sends the full layout and `titlesByLeafId` as the snapshot,
and `renamedLeafIds` as the delta (the panes the user renamed in this edit). The retired
`intent: 'gesture'` tag is stripped unread by the params schema, so older clients that still send it
keep working.
