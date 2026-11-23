# Configure the local DingTalk connector

The local connector runs inside Orca and uses the `dws` executable on this computer. It does not use Orca Cloud, MCP, or a webhook.

Create `dingtalk-local.json` inside the active Orca profile data directory. Set `DINGTALK_LOCAL_CONFIG` to use another path.

```json
{
  "enabled": true,
  "dwsPath": "/absolute/path/to/dws",
  "autoReply": false,
  "groups": [
    {
      "profile": "corpId:userId",
      "groupId": "openConversationId",
      "botId": "orca-bot-id",
      "mode": "at",
      "prefix": "/tsbot",
      "requirePrefix": true,
      "selfNames": ["Bot name"],
      "selfOpenId": "openDingTalkId",
      "noiseFilter": true
    }
  ]
}
```

Set `dwsPath` to the output of `command -v dws` (on Windows, `where dws`). The connector does not expand `$HOME`, `~`, or other variables. Omit `dwsPath` to find `dws` on `PATH`.

The connector reads the file when Orca starts. Set `mode` to `all` and `requirePrefix` to `false` to process every non-noise message in the group. Keep `autoReply` set to `false` until the local reply controls are available. The connector records queued and uncertain replies in its local ledger.

The profile must already be logged in with `dws auth login`. `groupId` is the group's `openConversationId`. `botId` is the Orca bot that owns the native conversation.

The connector stores its ledger in the profile data directory as `dingtalk-local-ledger.json`. It writes the file through a temporary file and rename, and uses one process as the writer. If an existing ledger cannot be read or fails validation, the connector does not start and leaves the file unchanged for diagnosis. Move the file away to start with an empty ledger.

The connector filters the account's own messages, applies the configured trigger, and sends accepted messages into the existing native external-conversation seam. A completed bot turn becomes a queued local reply. The stable reply UUID lets a confirmed `dws send` converge after a restart. An uncertain send remains unresolved until a person checks DingTalk.
