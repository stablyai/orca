# Local Docker over SSH

Load this when the environment is a local Docker container reached over SSH. It models an ephemeral
SSH VM without cloud cost: build a base image with `sshd`, tools, repo prerequisites, and the agent
CLI; run an interactive auth container once; then `docker commit` that container as the
authenticated image per-workspace `create` boots from. The emitted result is the SSH shape in
`references/ssh-host.md`.

- Publish container SSH to a random localhost port with `-p 127.0.0.1::22`, and emit
  `connection.type:"ssh"` with `host:"127.0.0.1"`, that port, `username`, `identityFile`, and
  `identitiesOnly:true`.
- Generate a repo-local SSH key if needed, and gitignore the private and public key files.
- Generate unique SSH host keys with `ssh-keygen -A` on each container's first start and retain
  them for that container's lifetime. Remove `/etc/ssh/ssh_host_*` from the base and auth images
  before reuse; never distribute one private host key across workspaces.
- Before connecting, read the container's public host key through trusted local `docker exec` and
  record it under `[127.0.0.1]:<published-port>` in the desktop's `known_hosts`. If a port was reused,
  replace only that endpoint's old entry after verifying the new container identity. Preserve
  entries for other workspaces; never disable host-key checking to bypass a mismatch.
- The auth image is the Docker form of the agent-auth snapshot: the user runs the agent login inside
  the container, configures proxy env and config, approves hooks, and you commit once they report it
  finished.
- Do not bind-mount or copy the host's full agent home into the image. Let each container keep
  writable agent state; only the committed auth image carries reusable authenticated state.
- When committing from an interactive shell, force the runtime entrypoint back to `sshd`:
  `docker commit --change='ENTRYPOINT ["/usr/local/bin/orca-docker-ssh-entrypoint"]' …`.
- `destroy` reads `recipeResult.userData.resourceId` and runs `docker rm -f "$resource_id"`.

## Validation before wiring or live use

```bash
docker image inspect "$auth_image" --format '{{json .Config.Entrypoint}}'
docker run -d --name "$name" -p 127.0.0.1::22 -e "ORCA_SSH_PUBLIC_KEY=$pubkey" "$auth_image"
docker ps -a --filter "name=$name"
docker logs "$name"
ssh -i "$key" -p "$port" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes user@127.0.0.1 'codex --version'
```

Inspect the auth image entrypoint and do this startup-only `docker run` before the full clone and
install path. If the container exits immediately, read its logs before the cleanup trap removes it;
an image committed from an interactive shell with `ENTRYPOINT ["bash"]` is a common cause.

Validate two containers: their public host keys must differ, and each must match its recorded
endpoint before SSH succeeds. Restarting the same container preserves its key; reusing a deleted
container's port requires verifying and recording the replacement's key. Remove that endpoint's
entry on destroy only if it still matches the destroyed container's recorded key.
