# Self-host the Node Orca server

This builds the existing `pnpm build:orcad` runtime, without Electron or Xvfb. The desktop connects using the existing server pairing and encrypted RPC protocol. No registry image is published by this configuration: `orca/orcad:…` is a local image built from your source checkout.

## Build and start

Use a source checkout, Node 24, the repository's installed dependencies (`@orca/process-host` must be built), Docker with BuildKit, and [Docker Compose v2.17.0 or newer](https://github.com/docker/compose/releases/tag/v2.17.0) for `up --wait-timeout`. Linux amd64 and arm64 builds use the repository's existing glibc 2.28 native-build images and verified pinned Node. The final image is Debian Bookworm and runs as UID/GID 1000 (`node`). macOS and Windows hosts use Docker's Linux engine; no host-native modules enter the image.

From the repository root:

```sh
node config/docker/orcad/configure.mjs
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml config --quiet
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml build
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml up -d --no-build --wait --wait-timeout 180
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml ps
```

`configure.mjs` creates the ignored `config/docker/orcad/.env`, refusing to overwrite an existing file unless passed `--force`. It records the full source revision, whether the checkout has changes, a source-content fingerprint and a versioned local image name. Edit this file before building to pin additional provider versions or change the connection address. Dependencies install only in the build stages; the runtime image carries the server bundle, native modules, pinned Node, support commands, and selected official CLIs.

The image records the source revision in its OCI label, the actual bundle content version in `/opt/orca/orcad/.version`, and metadata in `/opt/orca/docker/build.json`. `configuredSourceFingerprint` describes the checkout when configuration was generated; `builtSourceFingerprint` describes the copied build sources. If files changed between configuration and build, those hashes can differ; the bundle version and Docker image ID identify the exact built artifact. Reconfigure before a release build and record the image ID:

```sh
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml images
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml exec -T orcad cat /opt/orca/docker/build.json
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml exec -T orcad cat /opt/orca/providers/manifest.json
```

Do not run `configure --force` just to update an existing deployment: it resets address/provider choices to defaults. For updates, generate a separate file using `--output`, transfer the four source/image metadata fields to the deployment's `.env`, and preserve its address and provider settings.

## Connect a desktop

The service explicitly binds `0.0.0.0:6768` **inside** the container. Compose publishes only host `127.0.0.1:6768` by default. For another machine, either forward that port over SSH or publish on a private host interface:

```dotenv
ORCAD_PUBLISH_ADDRESS=100.100.10.20
ORCAD_PUBLISH_PORT=6768
ORCAD_PAIRING_ADDRESS=100.100.10.20:6768
```

Use an address reachable from the desktop, such as the server's private VPN address. `ORCAD_PAIRING_ADDRESS` can also be a complete `wss://` endpoint behind an existing WebSocket-capable TLS proxy. It changes the advertised address, not the listening port. For SSH forwarding, leave publication and the advertised address on loopback and forward local port 6768 to the server's loopback port 6768.

Read the startup pairing offer locally:

```sh
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml logs --tail 100 orcad
```

Paste the `pairing.url` from the `orca_server_ready` JSON into the desktop's existing **Settings → Remote Orca Servers → Add server → Paste access link** flow. This grants access to server-side workspaces and execution. Treat the pairing URL and readiness file as credentials; keep container logs private and revoke unneeded paired devices through the existing device controls. The pairing registry and host encryption identity persist in the state volume, so clients reconnect after replacement. Client/server capability and protocol negotiation remain unchanged; incompatible versions still refuse and newer optional features require host support. Pairing does not copy desktop provider accounts to this deployment.

## Persistent data and credentials

Keep all three volumes, together:

| Volume             | Container path  | Contents                                                                                                                                                                        |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orcad_home`       | `/home/node`    | `~/.orca` credential files and sealing keys; Claude's `~/.claude` and `~/.claude.json`; Codex/Gemini homes; XDG configuration/state; SSH configuration and user-installed tools |
| `orcad_state`      | `/var/lib/orca` | `ORCA_USER_DATA`: profiles, chat journal, pairing registry, account metadata, terminal state and logs; persistent `machine-id`                                                  |
| `orcad_workspaces` | `/workspaces`   | Folder projects, repositories, worktrees and project configuration                                                                                                              |

These are the actual names when using `-p orcad`; a different Compose project name gets distinct volumes. `ORCA_USER_DATA` does **not** relocate all credentials out of `HOME/.orca`. `/etc/machine-id` links to the state volume; the entrypoint creates a unique identity once, before launching the existing server. Retain it with the state volume so saved credentials can still decrypt after replacement. Do not mount the host's own home or machine-id.

Create/import projects under `/workspaces`. Folder projects work without Git. If replacing a named volume with a bind mount, prepare it for UID/GID 1000 and keep each absolute container path unchanged. Changes saved elsewhere in the container are ephemeral. The runtime is nonroot, so install additional system dependencies by extending the Dockerfile, and rebuild the image.

## Official provider CLIs and authentication

Claude Code defaults to exact version `2.1.310` of the original `@anthropic-ai/claude-code` package. Set `ORCAD_CLAUDE_CODE_VERSION` to a different exact version before building. `/opt/orca/providers/bin/claude` resolves to that package's executable. The existing Orca command resolver passes it to the original Claude Agent SDK's `pathToClaudeCodeExecutable`; this packaging adds no inference client or subscription-cookie conversion. Original provider configuration, permissions and billing behavior apply. [Claude Code's documented npm installation](https://code.claude.com/docs/en/setup#install-with-npm) supplies the same official native executable.

Authenticate **on the server**, as its service user, using the provider's interactive flow:

```sh
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml exec orcad claude auth login
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml exec orcad claude --version
```

Do not bake account files/tokens into the image or put them in build arguments. Server-owned homes retain CLI authentication and configuration. `DISABLE_AUTOUPDATER=1` keeps automatic Claude updates from silently changing the pinned image; rebuild to update the installed version. A user-installed executable in the home may override the packaged one only when intentionally selected in Orca's existing agent Command setting.

To include other original harnesses, set exact build versions in `.env`:

```dotenv
ORCAD_CODEX_VERSION=0.160.0
ORCAD_GEMINI_CLI_VERSION=0.65.0
```

These are example exact pins, not a promise to track the latest releases; empty values omit those packages. The packages are `@openai/codex` and `@google/gemini-cli`, installed into `/opt/orca/providers`, recorded with executable hashes and verified with `--version`. Authenticate Codex in the container:

```sh
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml exec orcad codex login
```

For Gemini, use the CLI's supported login flow. See [Codex CLI](https://developers.openai.com/codex/cli/) and [Gemini CLI installation](https://geminicli.com/docs/get-started/installation/). This source checkout also supports original Gemini CLI 0.65.0 or newer through its native ACP chat adapter. A signed-in new session supplies its model list. Native reopen/adoption is explicitly refused for the verified 0.65.0 protocol because its asynchronous history replay has no safe completion marker; saved Orca journals remain readable. Continue in the original terminal or start a new chat. Installing the CLI does not make every provider feature available. Other official CLIs can be installed in a derived image or the persisted user home and selected through existing agent settings.

`manifest.json` records package name, exact version, resolved executable, executable SHA-256 and reported CLI version. Installation and fixture checks run only `--version`, without provider login or paid prompts.

## Health and shutdown

Docker health uses the server's readiness offer to authenticate a fresh local encrypted RPC connection and request `status.get`. It then calls the existing terminal-daemon health protocol, including a real short-lived PTY spawn. An open TCP port alone is insufficient. Pairing credentials are kept in owner-only `/run/orca/readiness.json`; checks never print them.

The startup runtime grant is shared by this health probe and any desktop using that startup link. Reserve it while the container runs: revoking it also makes the authenticated health probe fail, even when the server and terminal daemon are still running. To retire this grant, revoke it through the existing device controls, restart the service with `docker compose -f config/docker/orcad/compose.yaml restart orcad`, and read the new startup offer from `/run/orca/readiness.json`. Pair the desktop with that new link. Docker does not restart the service merely because revocation made it unhealthy; restart explicitly. Revocation remains effective, and the old link must stay rejected.

The tiny init process reaps descendants, and the Node launcher forwards SIGTERM/SIGINT to the original server. Its existing teardown flushes state before exiting. Compose allows 60 seconds for shutdown and restarts on process exit unless manually stopped. Docker marks failed probes unhealthy; it does not automatically restart a still-running unhealthy container, so monitor that status. [Docker documents the init-process role](https://docs.docker.com/engine/containers/multi-service_container/).

```sh
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml stop
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml up -d --no-build --no-recreate --wait --wait-timeout 180
```

Container replacement ends live provider/shell processes. Durable workspaces and history remain, and supported provider sessions may be resumed through the existing runtime; this does not preserve running processes across container replacement. The image has no desktop display or system browser: desktop-control operations and server browser operations that require additional browser dependencies remain unavailable, while paired desktop capabilities continue to negotiate normally.

## Updates, backups and restore

Before an update, let active work finish, stop the service, and back up **all three volumes** consistently. For project `orcad`, stream an archive to protected backup storage through a temporary service container:

```sh
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml stop
umask 077
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml run --rm --no-deps -T --entrypoint tar orcad -czf - -C / home/node var/lib/orca workspaces > orcad-backup.tgz
```

The archive contains provider credentials and sealed keys; keep it private and use encrypted backup storage. Preserve numeric ownership. To restore into empty volumes, extract as UID 1000 before starting Orca:

```sh
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml run --rm --no-deps -T --entrypoint tar orcad -xzf - -C / < orcad-backup.tgz
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml up -d --no-build --wait
```

Retain the image ID/revision with the backup; newer SQLite state may require its matching version, so rolling back the image alone is not a guaranteed state rollback.

Build the selected new source revision with new metadata, then replace the service with the **same** Compose project/volumes:

```sh
node config/docker/orcad/configure.mjs --output config/docker/orcad/.env.next
# Copy the new source/image metadata into the deployment .env, preserving settings.
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml build
docker compose --env-file config/docker/orcad/.env -p orcad -f config/docker/orcad/compose.yaml up -d --no-build --force-recreate --wait --wait-timeout 180
```

`down` retains named volumes. `down --volumes` deletes them and is only appropriate for disposable fixtures or intentional decommissioning. Keep the Docker socket out of the service.

## Isolated acceptance fixture

After building, from the source checkout with its existing dependencies:

```sh
ORCA_BACKGROUND_LAUNCH=1 node config/docker/orcad/smoke.mjs
```

The script first reads `docker info`, then creates its own random Compose project, loopback port and empty volumes. It pairs an isolated client using the existing encrypted RPC client, verifies an official Claude executable without login, writes a workspace file, appends a fixture message using the real journal store, and seals a nonsecret credential placeholder using the existing host secret store. It substitutes an unregistered startup token to prove that health fails without a valid grant, then restores the real token and checks recovery; this simulates credential loss without revoking the fixture client's shared grant. It also suspends the terminal daemon to prove that health fails, resumes it, checks the same client credential and data after restart and replacement, verifies exit code zero on shutdown, and removes only its own containers/volumes. It never mounts host HOME or sends a provider prompt. Evidence is written to `.bench-fixtures/orcad-fixture-*/report.json`, excluding pairing tokens and encryption keys. Use `--env-file /absolute/path/to/config.env` to test an alternate locally built image.
