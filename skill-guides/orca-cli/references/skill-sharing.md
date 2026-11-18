<!-- host-capability: skill-publishing -->

# Skill sharing commands

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
- A denied command fails with `agent_skill_sharing_disabled`. Do not retry; the user turned
  the permission off. Mention the switch only if they asked to share skills through Orca.
- On a headless Orca server, skill and artifact sharing fail with `sharing_unavailable_on_host`.
  Do not retry; the host has no Orca cloud sign-in, so the user must share from the desktop app.
- Orca stages one agent-published bundle at a time per host. If another publish is active,
  wait for it to finish before retrying `agent_skill_sharing_busy`.
- Sharing again under a `--bundle-name` the account already published adds a new version to
  that package. `agent_skill_bundle_name_taken` means the name is already in use; do not
  retry, ask the user for a different name.
- Run the command in an Orca terminal on the machine that stores the skills. Forwarded WSL,
  SSH, and paired-runtime invocations fail before discovery so Orca cannot read from the
  wrong filesystem.
- The JSON result contains the unlisted URL and public share/package/version IDs. It never
  includes cloud authentication tokens.

<!-- /host-capability -->
