# NO_GITHUB_AUTHORITY worker image

This image is the narrow Alpha execution boundary for `no-github-authority/v1`. Build it from the
repository root:

```sh
docker build --tag orca-worker-authority config/worker-authority-image
```

The base image is digest-pinned and the Codex package is version-pinned. Orca admits the image only
when its local image ID matches the release constant. The container receives explicit worktree,
Git metadata, isolated provider-home, and lifecycle mounts; it never receives the Docker socket or
an Orca runtime socket/token. The worktree is writable, but Git metadata is mounted read-only and
repository-local Git configuration is masked with an empty read-only file. This lets workers inspect
changes without inheriting remotes, credential helpers, hooks-as-configuration, or permission to
mutate the shared repository metadata.

`orca-worker-report` is the only container-to-Orca lifecycle surface. It publishes one bounded,
Dispatch-bound receipt atomically with a create-only hard link, so the host never observes a partial
JSON file. The host adapter validates the receipt and converts it into existing Orca lifecycle
settlement. A newly published daemon removes only orphaned containers whose private CID, nonce, and
Docker labels all match.

The execution host must configure `ORCA_WORKER_CODEX_HOME` to a dedicated, revocable worker Codex
home containing `auth.json`. Orca fails preflight when it is missing or invalid and never falls back
to the operator's ordinary `CODEX_HOME` or `~/.codex`. Only the Orca process-owner environment is
authoritative for this setting; terminal, agent, repository, and task launch environments cannot
redirect the copied credential. Restart Orca after changing the process-owner setting.
