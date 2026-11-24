# Project groups across computers

## Decision

A project group saved on this client (the desktop you are using) can hold projects from any
connected computer (runtime hosts paired over Relay or directly). Groups saved on a remote host keep
the old rule: they accept only that host's own projects, so a laptop project still cannot join a
group stored on the VPS.

Why: users group projects by what they work on, not by which machine runs them. Writing the
membership to the remote host would change another computer's sidebar and needs that host online,
so the client keeps the membership itself.

## Storage

Client-local groups (`projectGroups` persistence domain) carry an optional field:

```ts
remoteMembers?: { hostId: 'runtime:<environmentId>'; projectId: string; order?: number }[]
```

- `hostId` + `projectId` identify the project unambiguously; only runtime hosts are kept (local and
  SSH projects use their own `projectGroupId`).
- `normalizeProjectGroups` drops invalid entries, dedupes a project across groups (first group in
  tab order wins) and deletes the field when empty. Older saved state without the field loads
  unchanged (`project-group-remote-members.test.ts`).
- Nothing is written to the remote host. The runtime RPC group-update schema strips the field and
  the mobile catalog schema ignores it.
- The renderer overlays memberships at read time (`selectSidebarRepos`): a remote repo with a
  client membership shows in that group with the stored order, overriding its host's own group.

## Limitations and behavior

- The group lives only on the client that made it. Other clients and the host itself do not see
  the remote project in it.
- Nesting stays per host: a group nests only inside a group saved on the same computer.
- Offline or disconnected host: the app keeps rendering the host's cached rows, so the project
  stays in the group as an offline row. Unpaired host: its rows leave the catalog, the group shows
  only its header, and the membership is kept so the project returns if the host is paired again.
- A member is dropped only after that host's live project list was applied and no longer contains
  it. A host being offline never removes memberships.
- In the host-sectioned sidebar view a remote member appears at the root of its own host section.
- Moving a project out of a client group reveals its host's own group, if it has one.
- The reworded "group is saved on another computer" toast is updated in English only; other
  locales still show the previous translation until they are re-translated.
