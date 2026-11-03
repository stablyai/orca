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
  "engines": { "orca": ">=1.4.249" },
  "contributes": {
    "sidebarCards": [
      { "id": "review-first", "title": "Review first", "template": "cards/review-first.json" }
    ]
  }
}
```

`orca plugin create <dir> --template card` scaffolds one. To use it for your workspaces, open the
plugin's page and choose **Use for workspaces**; **Use Orca's card** goes back. If a card fails to
load or draw, Orca draws its own card for that workspace and logs why.

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

Limits: 64 KiB per file, 400 nodes, depth 24, 100 vars, 32 props per node, and 1 KiB per string.
Expressions are capped at 2 KiB and nesting depth 32. `orca plugin check` reports every problem
with its path.

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

Orca parts draw Orca's own components and behave exactly as they do on Orca's card:

| Part                                                                            | What it draws                                           |
| ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `StatusLane` (`unreadAction`)                                                   | Activity, review status and the unread toggle           |
| `Title` (`dimWhenRead`, `tooltip`)                                              | The name, with double-click rename                      |
| `RepoChip`, `MetaRepoBadge`                                                     | The project as a chip or as a badge                     |
| `SshControl` (`iconOnly`), `RuntimeHostMark`, `HostBadge` (`label`)             | The host and SSH reconnect                              |
| `Branch` (`tooltip`), `IdentityLabel` (`tooltip`), `FolderPath`, `DetachedHead` | Identity                                                |
| `ConflictBadge`, `CacheTimer`, `RemoteBranchConflict`                           | Git state                                               |
| `PrimaryBadge`, `PrimaryStar`, `SparseBadge`                                    | Checkout kind                                           |
| `RenameError`, `DeleteFailed`, `DeleteQuickAction`                              | Errors, and delete while Option/Alt is held             |
| `Indicators` (`hover`: `meta`)                                                  | Linked items and ports                                  |
| `DetailsHover` (`branchName`, `workspaceTitle`)                                 | The workspace hover card around its one layout child    |
| `Agents` (`tight`)                                                              | Agent rows, with subagents                              |
| `LinearSetupPrompt`, `ChildToggle`                                              | The Linear setup prompt, and the child workspace toggle |

Orca keeps what surrounds the content: selection, drag, click and double-click, the context menu,
the delete overlay, sleeping dim, and where child workspaces nest.
