# Azure DevOps Authentication

Orca talks to the Azure DevOps REST API for pull requests and build statuses.
Requests authenticate through one of two paths, checked in this order:

1. **Environment tokens** — always win when set.
2. **Azure CLI (`az`) login** — automatic fallback for hosted Azure DevOps
   (`dev.azure.com` / `*.visualstudio.com`).

## Recommended: `az login`

If the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) is
installed and logged in, no configuration is needed:

```sh
az login
```

Orca acquires an Entra access token via
`az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`
(that GUID is Azure DevOps' fixed application ID, identical for every tenant)
and caches it in memory until shortly before expiry. The `azure-devops` CLI
extension is not required. Tokens are never written to disk by Orca; the az
CLI's own credential store is the source of truth, so `az logout` immediately
revokes access after the cached token (≤1 hour) expires.

## Fallback: environment tokens

Set these in the environment Orca is launched from (a packaged app does not
inherit shell profiles — on macOS use `launchctl setenv`, or start Orca from a
terminal):

| Variable                                                  | Purpose                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ORCA_AZURE_DEVOPS_TOKEN` (alias `ORCA_AZURE_DEVOPS_PAT`) | Personal access token, sent as Basic auth                                                       |
| `ORCA_AZURE_DEVOPS_ACCESS_TOKEN`                          | Pre-acquired bearer token, sent as `Authorization: Bearer`                                      |
| `ORCA_AZURE_DEVOPS_USERNAME`                              | Optional Basic-auth username paired with the PAT                                                |
| `ORCA_AZURE_DEVOPS_API_BASE_URL`                          | Override the API base URL when Orca cannot derive it from the git remote (required for on-prem) |

PAT scopes: **Code (Read & write)** covers pull request listing and creation;
add **Build (Read)** for build statuses. The Tasks surface additionally needs
**Work Items (Read)** and **Project and Team (Read)** — without them the
backlog view reports the request failure instead of showing items.

## On-prem Azure DevOps Server

Entra tokens only work against the hosted service, so Orca never consults the
az CLI for on-prem hosts. Set `ORCA_AZURE_DEVOPS_API_BASE_URL` to the
collection URL and provide a PAT via `ORCA_AZURE_DEVOPS_TOKEN`.

## Tasks

With authentication in place, Azure DevOps also appears as a task source on the
Tasks page: pick a team, pick a backlog level, and Orca shows the team's backlog
as Azure DevOps shows it — same items, order, hierarchy and columns. The team
choice is remembered per project in `azureDevOpsTeamSelection`.

Profiles that already carry a `visibleTaskProviders` list (any profile saved
before this provider existed) do not gain it automatically: enable Azure DevOps
under **Settings › Task Sources** to see it in the source picker.

The Backlog view expands one level — a row shows its direct children, not the
whole subtree — and the level picker lists the portfolio and requirement
backlogs, as the Azure DevOps Backlogs hub does.

The view mirrors the signed-in user's own Backlogs settings for the team, read
from `Settings/WebTeam/{teamId}/Entries/me` at the collection root: the column
options saved per level, the **Show parents** and **In progress items** view
options, and the saved filter for each level. Orca only reads them — resizing a
column, toggling a view option or changing a filter is local (column widths are
remembered per project/team/level in `azureDevOpsBacklogColumnWidths`; the
rest lasts for the session) and never writes back to Azure DevOps. When the
settings call fails (no permission, older on-prem servers) the process column
defaults apply and the view still loads. Rollup columns (progress and count
roll-ups) are not shown yet, and the work item type is never a text column: its
icon leads the title, as in Azure DevOps.

The Board view shows the same columns, swimlanes and cards as the team's board
in Azure DevOps. To draw it, Orca reads the board definition (`work/boards`,
`work/boards/{id}` and its `rows`), the card field and style settings
(`cardsettings` and `cardrulesettings`), the team's area paths
(`work/teamsettings/teamfieldvalues`), and the board's work items through a
WIQL query (`POST wit/wiql`, which only reads). All of these calls are
read-only: moving a card, editing a card or changing the board's settings in
Orca never writes to Azure DevOps.

A team whose board is scoped by a custom team field (projects migrated from
TFS) is queried by that field, not by `System.AreaPath`. Where Orca cannot
show the board exactly as Azure DevOps does, it says so above the grid instead
of quietly differing: cards whose column value maps to no column are parked in
the first in-progress column and flagged, and cards or parent items the server
did not return are counted in a notice. Only a level that has no board at all
falls back to the Backlog; a failed lookup is reported as a failure.
