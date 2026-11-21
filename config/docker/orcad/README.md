# Self-host the Node Orca server

This directory packages the existing `pnpm build:orcad` server, without Electron or Xvfb, as a Docker image that you build yourself from a source checkout. Nothing here publishes or pulls an Orca image: `orcad:local` is only the tag Compose gives your local build. The desktop connects through the existing server pairing and encrypted RPC protocol.

## Build and start

You need a Git checkout, Docker with BuildKit and [Docker Compose v2.17.0 or newer](https://github.com/docker/compose/releases/tag/v2.17.0) for `up --wait-timeout`. The build stages reuse the repository's glibc 2.28 native-build images for Linux amd64 and arm64 with a pinned Node. The final image is Debian Bookworm and runs as UID/GID 1000 (`node`). macOS and Windows hosts build it with Docker's Linux engine; no host-native modules enter the image.

From the repository root:

```sh
orcad_compose() { docker compose -p orcad -f config/docker/orcad/compose.yaml "$@"; }
export ORCAD_SOURCE_COMMIT="$(git rev-parse HEAD)"
orcad_compose build
orcad_compose up -d --no-build --wait --wait-timeout 180
orcad_compose ps
```

The build context excludes `.git`, so `ORCAD_SOURCE_COMMIT` supplies the revision recorded in the server bundle and the image's `org.opencontainers.image.revision` label. Set it again before every build. Other settings are optional; export them too, or keep them in the Git-ignored `config/docker/orcad/.env` and add `--env-file config/docker/orcad/.env` to `orcad_compose`:

| Variable                                          | Default               | Purpose                                        |
| ------------------------------------------------- | --------------------- | ---------------------------------------------- |
| `ORCAD_IMAGE`                                     | `orcad:local`         | Local image tag                                |
| `ORCAD_PUBLISH_ADDRESS`, `ORCAD_PUBLISH_PORT`     | `127.0.0.1`, `6768`   | Host address and port that Compose publishes   |
| `ORCAD_PAIRING_ADDRESS`                           | `127.0.0.1:6768`      | Address advertised in the pairing link         |
| `ORCAD_CLAUDE_CODE_VERSION`                       | `2.1.310`             | Exact Claude Code version                      |
| `ORCAD_CODEX_VERSION`, `ORCAD_GEMINI_CLI_VERSION` | empty (not installed) | Exact Codex and Gemini CLI versions to install |

## Connect a desktop

The server binds `0.0.0.0:6768` **inside** the container, and Compose publishes only host `127.0.0.1:6768` by default. For another machine, forward that port over SSH, or publish it on a private interface such as a VPN address:

```dotenv
ORCAD_PUBLISH_ADDRESS=100.100.10.20
ORCAD_PAIRING_ADDRESS=100.100.10.20:6768
```

`ORCAD_PAIRING_ADDRESS` can also be a complete `wss://` endpoint behind an existing TLS proxy. It changes the advertised address, not the listening port.

Read the startup pairing offer:

```sh
orcad_compose logs --tail 100 orcad
```

Copy `pairing.url` from the `orca_server_ready` JSON line, open **Settings → Remote Orca Servers → Add server** on the desktop and paste it as the access link. The link grants access to server-side workspaces and execution, so treat it, the container logs and `/run/orca/readiness.json` as credentials, and revoke unneeded devices through the existing device controls. The pairing registry and host encryption identity persist in the state volume, so paired clients reconnect after the container is replaced. Pairing does not copy desktop provider accounts to the server.

## Persistent data

Keep all three volumes together:

| Volume             | Container path  | Contents                                                                                         |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------ |
| `orcad_home`       | `/home/node`    | `~/.orca` credentials and sealing keys, provider CLI logins and configuration, SSH configuration |
| `orcad_state`      | `/var/lib/orca` | `ORCA_USER_DATA`: profiles, chat journal, pairing registry, terminal state, logs, `machine-id`   |
| `orcad_workspaces` | `/workspaces`   | Folder projects, repositories and worktrees                                                      |

The names assume `-p orcad`; another project name gets separate volumes. `/etc/machine-id` links into the state volume, where the entrypoint creates a unique identity once; saved credentials need it to decrypt. Never mount the host's home or machine-id. Create projects under `/workspaces`; folder projects work without Git. A bind mount replacing a volume must be writable by UID/GID 1000 at the same container path. Anything written elsewhere is lost when the container is replaced; extend the Dockerfile for extra system packages.

## Provider CLIs and authentication

Each selected CLI (`@anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli`) is installed at its exact version into `/opt/orca/providers`, checked with `--version`, and recorded with its executable hash in `/opt/orca/providers/manifest.json`. Orca's existing command resolution uses them; this packaging adds no inference client. `DISABLE_AUTOUPDATER=1` keeps Claude Code at the built version; rebuild to update it.

Sign in **on the server**, as its service user:

```sh
orcad_compose exec orcad claude auth login
orcad_compose exec orcad codex login
```

Use the Gemini CLI's own login flow. Logins persist in the home volume. Never bake tokens into the image or pass them as build arguments.

## Health and shutdown

The Docker health check reads the startup offer from owner-only `/run/orca/readiness.json`, opens an authenticated encrypted RPC connection for `status.get`, then runs the terminal daemon's health check, including a short PTY spawn. An open port alone does not pass. The probe shares the startup grant, so revoking that grant marks the container unhealthy even while the server runs. To retire it, revoke it, run `orcad_compose restart orcad` and pair with the new link from the logs. Docker does not restart a running unhealthy container; monitor its status.

`tini` reaps child processes and the launcher forwards SIGTERM and SIGINT to the server, whose existing teardown flushes state. Compose allows 60 seconds to stop. Replacing the container ends running provider and shell processes; workspaces and history remain. The image has no display or system browser, so operations that need them are unavailable.

## Updates, backups and restore

Before an update, let active work finish, stop the service and back up all three volumes together:

```sh
orcad_compose stop
umask 077
orcad_compose run --rm --no-deps -T --entrypoint tar orcad -czf - -C / home/node var/lib/orca workspaces > orcad-backup.tgz
```

The archive holds provider credentials and sealed keys; store it encrypted. To restore into empty volumes:

```sh
orcad_compose run --rm --no-deps -T --entrypoint tar orcad -xzf - -C / < orcad-backup.tgz
orcad_compose up -d --no-build --wait --wait-timeout 180
```

To update, check out the new revision and rebuild under the same project name so the same volumes are reused. A per-revision `ORCAD_IMAGE` tag keeps the previous image available:

```sh
export ORCAD_SOURCE_COMMIT="$(git rev-parse HEAD)" ORCAD_IMAGE="orcad:$(git rev-parse --short HEAD)"
orcad_compose build
orcad_compose up -d --no-build --force-recreate --wait --wait-timeout 180
```

Newer state may not open in an older version, so roll back an image together with its matching backup. `down` keeps named volumes; `down --volumes` deletes them. Never mount the Docker socket into the service.
