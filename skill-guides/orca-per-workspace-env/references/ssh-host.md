# SSH connection mode, including provisioned root

Load this when the recipe connects over SSH instead of starting `orca serve`, and when the user has
explicitly asked for `checkoutMode: provisioned-root`.

SSH mode is a different shape, not the Orca-server templates relabeled. `create` runs no
`orca serve` and emits no `pairingCode`. Orca connects over its SSH relay, brings up the git and
filesystem providers, and imports the repo. The script only readies the host and prints the SSH
details Orca dials.

## The result shape

Orca rejects anything else. Required fields only; add optionals from the next section as the
network needs them.

```json
{
  "schemaVersion": 1,
  "connection": {
    "type": "ssh",
    "projectRoot": "/abs/path/to/repo/on/host",
    "target": {
      "label": "my-box",
      "host": "192.0.2.10",
      "port": 22,
      "username": "ubuntu"
    }
  }
}
```

`label`, `host`, `port`, and `username` are required. `projectRoot` is an absolute path on the host.

## Which optional `target` fields to set

These describe how the user's desktop reaches the box; there is no `orca serve` URL in SSH mode.

- A public IP or DNS name, or a Tailscale or VPN address, is the `host`; the SSH port is `port`,
  usually 22.
- Key auth sets `identityFile`. Add `"identitiesOnly": true` when the agent holds many keys.
- A bastion is reached through one of two fields: `jumpHost` takes a `user@host` ProxyJump
  target, and `proxyCommand` takes a full command such as an access proxy. **Set one, never both.** The schema
  accepts both, and the two consumers then disagree: one pushes `-J` and `-o ProxyCommand=` into the
  same argv, the other resolves `proxyCommand` and ignores `jumpHost` entirely.
- A service port the workspace needs is an entry in `portForwards`. Each entry requires
  `localPort`, `remoteHost`, and `remotePort`, and takes an optional `label`. The entry schema is
  strict, so an invented key such as `local` or `remote` fails validation.
- `relayGracePeriodSeconds` bounds how long Orca keeps the SSH relay alive after the workspace
  detaches. **`0` means unbounded**: the relay stays up until something explicitly terminates it, so
  it is the wrong value for a disposable runtime. Any other value must be between 60 and 604800
  seconds. A value between 1 and 59, such as `30`, is rejected and takes the whole recipe result
  with it.
  Omit the field unless the user asked for a specific reconnect grace window.

## Toolchain and agent auth on a persistent host

A persistent host is its own base image. Run the install steps and the agent's device-auth login
over SSH once, by hand, before wiring the recipe. The login is interactive, for example
`ssh -t user@host '<agent> login --device-auth'`, so the user runs it. The host then stays ready
across workspaces.

## The create script

```bash
#!/usr/bin/env bash
set -euo pipefail
# resolve from env→state→fallback (default unset optionals to ""): ssh_username, host,
#   ssh_port (default 22), identity_file, jump_host, proxy_command, project_root, repo_url, repo_ref
: "${identity_file:=}"; : "${jump_host:=}"; : "${proxy_command:=}"   # avoid set -u aborts on optionals
gh_token="${GH_TOKEN:-${GITHUB_TOKEN:-$(command -v gh >/dev/null 2>&1 && gh auth token 2>/dev/null || true)}}"
ssh_target="${ssh_username}@${host}"
if [ -n "$jump_host" ] && [ -n "$proxy_command" ]; then
  echo "set jump_host or proxy_command, not both" >&2; exit 1
fi
# A fresh host's key isn't in known_hosts, and a StrictHostKeyChecking prompt HANGS a
# non-interactive create. accept-new records the first key seen and never prompts; if the
# provider publishes the host fingerprint, compare it after the first connection.
ssh_opts=(-p "$ssh_port" -o StrictHostKeyChecking=accept-new)
[ -n "$identity_file" ] && ssh_opts+=(-i "$identity_file")
[ -n "$jump_host" ] && ssh_opts+=(-J "$jump_host")
[ -n "$proxy_command" ] && ssh_opts+=(-o "ProxyCommand=$proxy_command")

# 1. ensure the repo is present and at the right commit on the host (NO orca serve here).
#    printf %q quotes every value for the remote shell, so a space or quote in a path or
#    ref cannot break out of the command.
remote_sync='set -euo pipefail
  [ -d "$project_root/.git" ] || git clone "$repo_url" "$project_root"
  cd "$project_root" && git fetch origin "$repo_ref" && git checkout -B "$repo_ref" FETCH_HEAD'
ssh "${ssh_opts[@]}" "$ssh_target" "$(printf \
  'GH_TOKEN=%q GIT_TERMINAL_PROMPT=0 project_root=%q repo_url=%q repo_ref=%q bash -lc %q' \
  "$gh_token" "$project_root" "$repo_url" "$repo_ref" "$remote_sync")" >&2

# 2. print the SSH connection block (NO pairingCode, NO orca serve). host/port/username tell Orca's
#    relay how to dial in; identityFile/jumpHost/proxyCommand/portForwards are emitted when set.
node -e 'const [host,port,user,idf,jh,pc,root]=process.argv.slice(1);
  const target={ label:"per-workspace-host", host, port:Number(port), username:user };
  if(idf) target.identityFile=idf; if(jh) target.jumpHost=jh; if(pc) target.proxyCommand=pc;
  // add target.portForwards=[{localPort,remoteHost,remotePort}] here if the workspace needs them
  console.log(JSON.stringify({ schemaVersion:1, connection:{ type:"ssh", projectRoot:root, target } }))' \
  "$host" "$ssh_port" "$ssh_username" "$identity_file" "$jump_host" "$proxy_command" "$project_root"
```

On a persistent host there is usually nothing to tear down, so set `destroy: none` and omit suspend
and resume. Orca still disconnects and reconnects its own SSH relay on sleep, wake, and delete, which
is separate from these scripts.

If the SSH host is instead an ephemeral, snapshot-capable VM — the user's hypervisor, or a cloud VM
with image support — keep the base-image model from `references/provider-vercel.md` for
provisioning, but still emit the `connection.type:"ssh"` block above instead of starting
`orca serve`.

## Provisioned root

For an explicitly requested one-VM-per-workspace checkout, the create script reads
`ORCA_RECIPE_RESULT_SCHEMA_VERSION`, `ORCA_REPO_URL`, `ORCA_REPO_REF`, `ORCA_REPO_REF_HEAD`, and
`ORCA_REPO_BRANCH`. Use `ORCA_REPO_REF` to fetch the selected source, but create `ORCA_REPO_BRANCH`
at the exact `ORCA_REPO_REF_HEAD` commit, because resolving the symbolic ref again can race with an
upstream update. `ORCA_REPO_URL` and `ORCA_REPO_REF` are a matched fetch pair, and the URL is the
remote Orca resolved the base ref against, which is not necessarily named `origin` on the desktop.
Fetch from the URL the pair supplies:

```bash
[ -n "${ORCA_REPO_REF_HEAD:-}" ] || { echo "missing pinned source commit" >&2; exit 1; }
git fetch "$ORCA_REPO_URL" "$ORCA_REPO_REF"
git cat-file -e "${ORCA_REPO_REF_HEAD}^{commit}"
git checkout -B "$ORCA_REPO_BRANCH" "$ORCA_REPO_REF_HEAD"
```

Return that primary checkout at `projectRoot` and emit schema version 2:

```json
{
  "schemaVersion": 2,
  "checkoutMode": "provisioned-root",
  "connection": {
    "type": "ssh",
    "projectRoot": "/abs/repo",
    "target": { "label": "my-box", "host": "192.0.2.10", "port": 22, "username": "ubuntu" }
  }
}
```

## Before declaring an SSH recipe done

The `--provision` self-test only sees what the scripts print, so smoke-test the exact emitted target
as well: dial the host and port with the identity or proxy settings, run `pwd`, verify the repo path,
check the agent binary, and confirm `destroy` removes the provider resource.
