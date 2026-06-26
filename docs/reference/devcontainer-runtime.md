# Devcontainer runtime setup

Orca can manage worktrees and terminals inside a devcontainer by pairing the desktop app with an `orca serve` runtime that runs in the container.

This is useful when project tooling, credentials, or dependencies only exist inside the devcontainer.

## 1. Start Orca inside the devcontainer

Install the Linux Orca build in the devcontainer, then start a headless runtime:

```sh
orca serve --json --port 6768 --pairing-address 127.0.0.1:31682
```

Expose the container port to the host so desktop Orca can reach it. The pairing address must be the host-reachable address, not the container-local address.

Copy the `pairing.url` from the JSON output and save it on the desktop:

```sh
orca environment add --name lac-devcontainer --pairing-code 'orca://pair?code=...'
orca status --environment lac-devcontainer --json
```

## 2. Configure a persistent worktree base

Do not leave worktrees under the container home directory, such as:

```text
/home/vscode/orca/workspaces/...
```

That location may be lost when the container is rebuilt or deleted.

Choose a bind-mounted workspace path instead, for example:

```text
/workspaces/lac/projects/.worktrees/orca
```

Then configure the project in one command:

```sh
orca project setup-devcontainer \
  --environment lac-devcontainer \
  --project git:bitbucket.org/acme/app \
  --host local \
  --path /workspaces/lac/projects/app \
  --worktree-base-path /workspaces/lac/projects/.worktrees/orca \
  --kind git
```

Both `--path` and `--worktree-base-path` are paths inside the devcontainer runtime. When using `--environment` or `--pairing-code`, they must be absolute server paths because the desktop CLI current directory is unrelated to the container filesystem.

`setup-devcontainer` intentionally requires a paired runtime selector (`--environment`, `--pairing-code`, `ORCA_ENVIRONMENT`, or `ORCA_PAIRING_CODE`) so it cannot accidentally configure the desktop-local Orca runtime.

New worktrees will be created under the persistent base, grouped by repo name:

```text
/workspaces/lac/projects/.worktrees/orca/app/<worktree-name>
```

## 3. Add multiple repos from a parent folder

The desktop UI can scan a runtime path for nested git repositories and import them. Use the add-project/add-repo flow for the paired runtime and enter the parent path inside the container, such as:

```text
/workspaces/lac/projects
```

Runtime scans are bounded and do not currently have the same streaming progress or cancel support as local scans.

## Notes and limitations

- The devcontainer runtime must keep `orca serve` running.
- Use normal runtime pairing, not mobile pairing.
- If the devcontainer does not include the libraries required by Electron, install the Linux desktop runtime dependencies before starting `orca serve`.
- Some container environments require disabling Electron's sandbox or running under a virtual display, depending on the base image.
- The CLI helper assumes the runtime environment already exists; it does not install Orca, start the container, or create the pairing.
- The helper imports the checkout first, then updates the worktree base path. If the second step fails, rerun `setup-devcontainer` or run `project setup-update --setup <setup-id> --worktree-base-path <path>`.
