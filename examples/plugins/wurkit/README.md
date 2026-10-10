# Wurkit plugin for Orca

The side panel lists open Wurkit Packages with status and assignee, filters by project, and sends `Wurk <TICKET> in Wurkit.` to a selected terminal in the focused worktree.

## Install for development

1. Open Orca's Plugins page and choose **Install from folder**.
2. Select this `examples/plugins/wurkit` directory.
3. Review and grant the requested capabilities.
4. Create a Wurkit API key limited to `projects.read`, `packages.read`, and `agents.read`.
5. Open the Wurkit panel, save the key, select a project and ticket, choose an agent terminal, and click **Wurk this**.

The panel has no network access. Its host-injected CSP blocks connections. The out-of-process Node worker calls only the fixed `https://api.wurkit.app/api/rest` read endpoints; the API key is stored with Orca's encrypted plugin-secrets vault and is never written to plugin storage or returned to the panel. Terminal selection is explicit and Orca rechecks that the target remains in the focused worktree before sending.

The ticket list is fetched on open and on manual/project-filter refresh. Each open-status query and the project list are capped at 100 rows; the panel reports when a cap hides more results.
