# TAPD Tasks example

This example maps TAPD requirements, bugs, and tasks into the Orca Tasks page. It requires a
development build with the task-source and plugin settings contributions from
[stablyai/orca#26282](https://github.com/stablyai/orca/pull/26282). The manifest's engine version
describes the plugin schema baseline. Released Orca builds with reserved task-source contributions
cannot load this example.

1. Load this directory as a development plugin and review its permissions.
2. In **Settings → Plugins → TAPD Tasks**, set the TAPD project ID and the absolute folder path of
   a project you have added to Orca.
3. Open **TAPD Connection** in the right sidebar and save a TAPD personal access token with read
   access to the project. The panel stores it in the plugin's encrypted secrets store.
4. In **Tasks → TAPD**, select a work item type. Search by title or by a full ID prefixed with
   `#`. Open an item to see its description and its link to TAPD.
5. Select **Start workspace** to review the prefilled project and editable agent prompt. The
   list provides the item title, ID and link. Starting from the detail view also includes the
   description. Confirm in Orca to create the workspace.

The worker makes read-only calls to `api.tapd.cn`, scoped to one configured TAPD project. Status
names come from TAPD. Project discovery, updates, and comments are outside this example's scope.
