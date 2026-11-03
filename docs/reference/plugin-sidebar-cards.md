# Workspace cards (`contributes.sidebarCards`)

A card plugin redraws the workspace cards in the left sidebar. A card is a JSON **template**. Orca
draws it from facts about each workspace, using its own card parts and a few layout and text
primitives. A template runs no code, so a card-only plugin uses the `data` profile and installs
with one click, like a theme.

Orca's own card is a template in this format:
[`default-workspace-card.json`](../../src/renderer/src/components/sidebar/workspace-card/default-workspace-card.json).
Copying it gives you today's card exactly, which you can then change.

## Manifest

```json
{
  "manifestVersion": 2,
  "execution": "data",
  "engines": { "orca": ">=1.4.248" },
  "contributes": {
    "sidebarCards": [
      { "id": "review-first", "title": "Review first", "template": "cards/review-first.json" }
    ]
  }
}
```

`orca plugin create <dir> --template card` scaffolds one. To use it, right-click a workspace and
choose **Customize** to open the Card Studio, then pick the card. The plugin's page also offers
**Use for workspaces**, and **Use Orca's card** goes back. If a card fails to
load or draw, Orca draws its own card for that workspace and logs why.

## Previews and the catalog

The Card Studio's **States** tab draws a card on made-up workspaces: agent working, needs input or
done, pull request open, failing or merged, merge conflicts, a folder, SSH disconnected, compact
layout, long names and detached HEAD. These previews read nothing from your workspaces and run no
plugin code, so a card can be previewed before it is installed.

A catalog release lists its cards in `cardPreview` (up to 4, each `{ "label", "template" }`, the
same template the plugin ships), and the Studio's **More cards** offers them with **Preview** and
**Install**. List the plugin under the `card` type. Orca's own cards ship as the bundled
**Workspace Cards** plugin: Minimal, Agent first and Review first.

## Options

A card can declare `options` in the same format as `contributes.settings`. The Card Studio shows
them as controls. The template reads the person's values, with defaults filled in, as
`cardOptions.<key>`:

```json
"sidebarCards": [{
  "id": "focus", "title": "Focus", "template": "cards/focus.json",
  "options": [{ "key": "showBranch", "title": "Show branch", "type": "boolean", "default": true }]
}]
```

```json
{ "el": "Branch", "when": "cardOptions.showBranch" }
```

## Template

```json
{
  "version": 1,
  "facts": 1,
  "vars": { "failing": "review.status == 'failure'" },
  "frame": { "singleLine": false, "statusLane": false },
  "defs": { "Header": { "el": "Row", "children": [{ "el": "Title" }] } },
  "root": { "el": "Row", "children": [{ "el": "StatusLane" }, { "el": "Header" }] }
}
```

- **`root`** is the card's content. A node is
  `{ "el", "when"?, "props"?, "children"? }`. `when` hides the node when its expression is false.
- **`vars`** are named expressions, evaluated in order. Later ones read earlier ones as
  `vars.<name>`.
- **`defs`** are named subtrees. A node whose `el` names a def draws that subtree. A def may not use
  itself.
- **`frame`** answers what Orca's card frame needs:
  - `singleLine` gives one-line cards tighter padding;
  - `statusLane` means the card leads with a status lane, which nested indentation aligns to.
- **Props.** A string that starts with `=` is an expression, for example `"text": "=review.title"`.
  Any other value is used as it is.

Limits: 64 KiB per file, 400 nodes (200 once defs are expanded), depth 24, defs nested 8 deep,
100 vars, 32 props per node, and 1 KiB per string. A card may take 4,000 expression steps per draw;
past that, that card draws as Orca's card and the reason is logged.
Expressions are capped at 2 KiB and nesting depth 32. `orca plugin check` reports every problem
with its path.

## Lists, times and text

- **`Each`** draws its children once per item of a list fact, reading the item as `item.*`:
  `{ "el": "Each", "props": { "items": "=activity.agents", "limit": 4 }, "children": [...] }`.
  At most 20 items.
- **`RelativeTime`** shows a time such as `5m ago` (`format`: `short`, `long` or `duration`).
  Orca keeps it current, so templates never read a clock.
- **`strings`** holds the template's own text by language, read with `t('key')`. The person's
  language is used, then its base language, then `en`:
  `"strings": { "en": { "noReview": "No pull request" }, "ja": { "noReview": "プルリクエストなし" } }`.
- **`fields`** are values the plugin's own worker sets for a workspace with
  `cards.setFields({ workspaceId, fields })`: strings, numbers, booleans and null, at most 32 keys
  and 4 KiB per workspace, redrawn at most 4 times a second. The template reads `fields.<key>`.

A path the fact model does not have (a typo such as `ws.brnach`) is an error in `orca plugin check`
and at load, never a silent empty value.

## Expressions

The grammar:

- literals (`'text'`, `"text"`, numbers, `true`, `false`, `null`) and fact paths (`review.number`);
- the operators `! && || ?? ?: == != < <= > >= + -`;
- the functions `len`, `trim`, `lower`, `upper` and `contains(listOrText, value)`.

`+` joins text unless both sides are numbers. A missing fact reads as `null` and never throws.
There is no way to call a value, index by a computed key, or reach a prototype. Expressions read
facts and do nothing else.

## Facts (version 1)

Facts are host-neutral. SSH and Orca-server workspaces report through `host`. Folder workspaces
have `ws.kind == 'folder'`, an empty branch, and no review.

| Path                                                                                                                                        | Meaning                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `ws.id`, `ws.name`, `ws.title`, `ws.path`                                                                                                   | Identity. `title` is the name the card shows.                                          |
| `ws.kind`                                                                                                                                   | `git` or `folder`.                                                                     |
| `ws.branch`, `ws.identity`                                                                                                                  | Short branch name, or `''`. `identity` is the branch or, where shown, the folder path. |
| `ws.isMain`, `ws.isSparse`, `ws.detachedHead`, `ws.isPinned`, `ws.isUnread`                                                                 | Flags.                                                                                 |
| `ws.isDeleting`, `ws.isRenaming`, `ws.hasRenameError`, `ws.removalError`, `ws.comment`                                                      | State and the workspace comment.                                                       |
| `repo.id`, `repo.name`, `repo.ssh`                                                                                                          | The project, or `null`.                                                                |
| `host.kind`, `host.contextLabel`, `host.runtimeDisconnected`                                                                                | `local`, `ssh` or `runtime`; the host label the list shows.                            |
| `git.conflictOperation`, `git.remoteBranchConflict.remote`, `git.remoteBranchConflict.branch`, `git.cacheTimerActive`                       | A merge or rebase in progress, and the other Git states.                               |
| `review.provider`, `review.number`, `review.title`, `review.state`, `review.status`, `review.url`                                           | The pull or merge request, or `null`. `status` is the combined checks result.          |
| `checks.total`, `checks.passing`, `checks.failing`, `checks.pending`                                                                        | Check counts.                                                                          |
| `links.count`, `links.issue`, `links.linearIssue`, `links.jiraIssue`                                                                        | Linked items.                                                                          |
| `provenance.automation`, `provenance.cli`                                                                                                   | Created by an automation or the CLI.                                                   |
| `ports.count`                                                                                                                               | Ports the workspace listens on.                                                        |
| `lineage.childCount`, `lineage.collapsed`, `lineage.toggleable`                                                                             | Child workspaces.                                                                      |
| `place.isActive`, `place.inPinnedSection`, `place.hideRepoBadge`, `place.showProjectName`, `place.affiliateList`, `place.deleteQuickAction` | Where and how the list shows the card.                                                 |
| `options.style`, `options.show.<property>`, `options.agentRows`                                                                             | The person's card settings. `style` is `classic`, `compact` or `new`.                  |
| `env.projectGroups`                                                                                                                         | Project groups are on.                                                                 |

## Elements

Layout and text primitives:

| Element        | Props                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Row`, `Stack` | `gap` (`xs` `sm` `md` `lg`), `align` (`start` `center` `end`), `justify` (`center` `end` `between`), `fill`, `grow`, `keep` (does not shrink), `push` (to the end), `inset` (`end`), `overflow` (`clip` `visible`), `hoverGroup`, `marker` |
| `Text`         | `text`, `size` (`title` `body` `meta` `micro`), `tone` (`neutral` `accent` `success` `warning` `danger`), `muted`, `weight` (`medium` `semibold`), `mono`, `truncate`                                                                      |
| `Badge`        | `text`, `tone`                                                                                                                                                                                                                             |
| `Icon`         | `name` (from the panel icon set), `tone`                                                                                                                                                                                                   |

Orca parts draw Orca's own components and behave exactly as they do on Orca's card. Each part shows
only the state its facts say: a template chooses where a part goes, never what it claims (a
`PrimaryBadge` on a workspace that is not the primary checkout draws nothing).

| Part                                                                            | What it draws                                                                       |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `StatusLane` (`unreadAction`)                                                   | Activity, review status and the unread toggle                                       |
| `Title` (`dimWhenRead`, `tooltip`)                                              | The name, with double-click rename                                                  |
| `RepoChip`, `MetaRepoBadge`                                                     | The project as a chip or as a badge                                                 |
| `SshControl` (`iconOnly`), `RuntimeHostMark`, `HostBadge`                       | The host and SSH reconnect                                                          |
| `Branch` (`tooltip`), `IdentityLabel` (`tooltip`), `FolderPath`, `DetachedHead` | Identity                                                                            |
| `ConflictBadge`, `CacheTimer`, `RemoteBranchConflict`                           | Git state                                                                           |
| `PrimaryBadge`, `PrimaryStar`, `SparseBadge`                                    | Checkout kind                                                                       |
| `RenameError`, `DeleteFailed`, `DeleteQuickAction`                              | Errors, and delete while Option/Alt is held                                         |
| `Indicators` (`hover`: `meta`)                                                  | Linked items and ports                                                              |
| `DetailsHover`                                                                  | The workspace hover card around its one layout child; it names the workspace itself |
| `Agents` (`tight`)                                                              | Agent rows, with subagents                                                          |
| `LinearSetupPrompt`, `ChildToggle`                                              | The Linear setup prompt, and the child workspace toggle                             |

On a plugin card, Orca's frame marks a workspace whose agent needs input, whatever the template
draws, and a collapsed list section still shows the workspaces that need the person.

Orca keeps what surrounds the content: selection, drag, click and double-click, the context menu,
the delete overlay, sleeping dim, and where child workspaces nest.

## Workspace lists (`contributes.workspaceLists`)

A list plugin arranges the sidebar's workspace list into its own sections. Like a card, it is data,
so it uses the `data` profile and runs no code:

```json
"workspaceLists": [{ "id": "flow", "title": "Attention flow", "arrangement": "lists/flow.json" }]
```

```json
{
  "version": 1,
  "facts": 1,
  "sections": [
    {
      "id": "needs-you",
      "title": "Needs you",
      "when": "activity.tier == 'needs-you' || ws.isUnread"
    },
    { "id": "working", "title": "Working", "when": "activity.tier == 'working'" },
    { "id": "done", "title": "Done", "when": "activity.tier == 'done'", "collapsed": true },
    { "id": "rest", "title": "Everything else" }
  ],
  "sort": [{ "by": "ws.lastActivityAt", "dir": "desc" }]
}
```

- A workspace lands in the first section whose `when` is true. A section with no `when` takes
  everything that reaches it. `fallback` names where unmatched workspaces go (by default, the last
  section). Empty sections are hidden.
- `collapsed` sections start collapsed when the list is picked; after that, the person's own
  toggles win.
- `sort` keys are fact paths, with `asc` or `desc`. Missing values sort last. Ties keep the
  person's own Sort by order.
- Pinned workspaces, child workspaces nested under their parent, and host sections stay Orca's.
  Folder workspaces join the last section.
- Pick a list in the Card Studio under **List**, or on the plugin's page with **Use for the list**.
  **Orca's grouping** goes back to Group by and Sort by.

List rules read row facts the list already holds, so arranging stays cheap with hundreds of
workspaces:

| Path                                                       | Meaning                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ws.id`, `ws.name`, `ws.branch`, `ws.kind`                 | Identity; `kind` is `git` or `folder`.                                     |
| `ws.isPinned`, `ws.isUnread`, `ws.isMain`, `ws.hasComment` | Flags.                                                                     |
| `ws.status`                                                | The workspace status lane, such as `in-progress`.                          |
| `ws.lastActivityAt`, `ws.createdAt`                        | Times in milliseconds.                                                     |
| `repo.id`, `repo.name`, `repo.ssh`                         | The project, or `null`.                                                    |
| `review.lane`                                              | `in-progress`, `in-review`, `done` or `closed`, as Group by PR names them. |
| `activity.tier`                                            | `needs-you`, `working` or `done`; `null` when no agent ran.                |
