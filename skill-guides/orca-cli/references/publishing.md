# Artifact and skill publishing commands

The publish gate and its recovery are in the guide body. This is the command surface behind it.

## Artifacts

```text
ORCA artifacts share <file> --json
ORCA artifacts update <file> --json
ORCA artifacts unshare <file> --json
ORCA artifacts list [--cursor <cursor>] --json
ORCA artifacts delete <id> --json
```

- `share`, `update`, and `unshare` accept `.html`, `.htm`, `.md`, and `.markdown` files.
- `share` saves the returned edit token in the active Orca profile and never includes it
  in CLI output. `update` and `unshare` look up that record by the resolved local file
  path, so use the same path and Orca profile that originally shared the file.
- `list` returns one page of artifacts owned by the signed-in account. If JSON output has
  `nextCursor`, pass it back with `--cursor <cursor>`. `delete <id>` deletes an account-owned
  artifact by the id returned from `list`; it does not need the original local file or its
  edit-token record.
- Relative HTML assets are not uploaded. Share a self-contained HTML file or use absolute
  asset URLs.
- If an upload exceeds the CLI transport limit, use the browser upload page as directed
  by the error.
- For local or staging development, `--api-url <url>` overrides the artifact service;
  `ORCA_ARTIFACTS_API_URL` provides the same override for the session.
- `ORCA_CLOUD_AUTH_TOKEN` is a development-only authentication override. Prefer the active
  Orca profile's normal PropelAuth session and never expose the token in logs or agent output.

## Skill sharing

Agents can publish one or more installed skills behind one unlisted link through the
signed-in Orca account. The user must first grant the separate, default-off permission in
Settings → Share Skills ("Allow agents and the Orca CLI to publish skill links"). There is
no CLI or RPC way to grant it. Manual publishing from the reviewed desktop flow remains
available without this agent permission.

```text
ORCA skills installed --json
ORCA skills share --skill <selector> [--skill <selector> ...] --bundle-name <name> --json
```

- `skills installed` returns safe discovery IDs and names. It does not expose local skill
  paths in CLI output. Sharing then verifies that each `SKILL.md` declares a portable
  lowercase name containing only letters, numbers, and hyphens.
- Each `--skill` must be an exact discovery ID or an unambiguous installed-skill name.
  Use IDs when names collide.
- Multiple `--skill` flags create one bundle and one link. `--all` and arbitrary paths are
  intentionally unsupported; name every skill the user asked to publish.
- Skill folders can contain scripts, configuration, or credentials. The permission is
  authority, not intent: publish only the skills the user named and never widen the set.
- A denied command fails with `agent_skill_sharing_disabled`. Do not retry; ask the user to
  enable the switch in the desktop app if they want this action.
- Orca stages one agent-published bundle at a time per host. If another publish is active,
  wait for it to finish before retrying `agent_skill_sharing_busy`.
- Run the command in an Orca terminal on the machine that stores the skills. Forwarded WSL,
  SSH, and paired-runtime invocations fail before discovery so Orca cannot read from the
  wrong filesystem.
- The JSON result contains the unlisted URL and public share/package/version IDs. It never
  includes cloud authentication tokens.
