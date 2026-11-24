# Read Commander from an assistant

To give Commander a goal directly, choose **Commander → Talk to Commander** on desktop or open the same paired desktop in Orca Mobile and tap **Talk to Commander**. The host keeps the conversation. Orca agents can send mail to its Home Chat through `orca orchestration send --to bot:<name> --type question --subject <subject> --body <question>`. Look up its current name with `orca bot list`.

Run the stdio MCP server in a local assistant client on a machine with Node 24, Orca CLI and the Orca source dependencies installed. It reads the same paired runtimes and profile as the CLI process. Configure the command and arguments in the client, using absolute paths for this machine.

```json
{
  "mcpServers": {
    "orca-commander": {
      "command": "node",
      "args": ["/absolute/path/to/orca/scripts/commander-mcp.mjs", "--environment", "local"]
    }
  }
}
```

Use a paired environment name or ID in place of `local`. Omit `--environment` for a briefing across local and paired runtimes. Pass `--cli /absolute/path/to/orca-ide` if the client cannot find Orca on its PATH.

Ask the assistant to call `commander_briefing`, for example “Which goals need my decision?” Each read collects the latest project setups, goal task counts, pending decision gates and any unavailable data. Clients that support MCP resources can read and subscribe to `orca://commander/briefing`. While subscribed, the server checks for changes every 30 seconds and sends `notifications/resources/updated` when the briefing differs. The client reads the resource again to obtain the new briefing.

This adapter supports local stdio clients. A hosted assistant that accepts only remote MCP endpoints requires a separate authenticated transport. Messages and actions between running Orca agents use the existing [orchestration commands](../site/content/docs/cli/orchestration.mdx).

## Project guidelines and agent decisions

In the Commander Memory tab, choose a project and export a memory grant for the agent's own name and the **agent** role. Save the grant in a private directory outside the checkout. Pass `--memory-grant /absolute/path/to/commander-agent-grant.json` in the MCP server arguments. The adapter then exposes `commander_guidelines`, `commander_ask_preference`, `commander_recall`, `commander_save_memory` and `commander_remove_memory`. Guidelines include applicable project and account-wide human guidance. Recall searches current titles, text and linked page IDs, newest first, and accepts a page ID to read its history. Note and decision writes carry the grant's project and agent identity. For retries, reuse the same request ID and arguments. After a version conflict, inspect the latest revision before editing again.

Enable **Commander → Memory → Use recurring answers** on the account first. For a recurring project choice, call `commander_ask_preference` with the task’s project ID, the owner’s exact question, and a stable ID for this occurrence.

```json
{
  "projectId": "github:org/api",
  "question": "Which Node version should release builds use?",
  "requestId": "release-42-node-version"
}
```

The tool accepts up to 500 characters of plain text. It trims the ends and compares the remaining question exactly. On a match, the memory service records the decision and returns the answer, the rule page ID and revision, and the decision page ID. Retry an interrupted call with the same arguments. A new occurrence gets a new request ID. A disabled account returns `{matched:false,reason:"disabled"}`, including for a prior successful request. A missing or conflicting rule also returns a reason. In each case, ask the owner. This lookup uses the project's agent grant and needs no model call.

A fresh Codex or Claude session can call `commander_resume_context` with no arguments to list saved handoffs in its granted project. Each item includes the goal, page ID, revision and save time. Call the same tool with `{"pageId":"<selected handoff ID>"}` to read the latest saved progress and next step. Use `offset` and `limit` to page through the list. Compare the branch, commit and local changes in the checkout before continuing. Call `commander_guidelines` for the account and project instructions. These reads do not send a message to a provider.

The grant expires in fifteen minutes. Export another to the same file to renew it for this client. A **commander** grant is for Commander dispatch, which records separate Commander attribution. Neither grant contains account sign-in credentials.

To inspect JavaScript and TypeScript import relationships, set `--repo /absolute/path/to/checkout` and call `commander_code_graph`. The tool accepts a repository-relative file or directory; its result includes the checked commit and coverage limits.

## Desktop account changes

The preload bridge uses the active local profile ID, cloud user ID and active organization for every read and write. The desktop main process calls the Commander routes on the configured Orca Cloud API origin, using the existing refreshable Orca session. Redirects are refused. A renderer should discard previously loaded pages and drafts on sign-out, profile or organization changes, and show errors from stale requests. A project checkpoint is attributed to the project-scoped `orca-checkpoint` Commander. A human edit is attributed to the signed-in account.
