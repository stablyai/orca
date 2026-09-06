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
- **Bake SSH host keys into the base image**, with `ssh-keygen -A` at build time and a runtime step
  that generates them only if absent. Every ephemeral container then presents the same host key, so
  `known_hosts` on `127.0.0.1` does not churn as the published port rotates across workspaces.
  Without this, each container's freshly generated key collides on localhost and trips host-key
  changed warnings.
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
ssh -i "$key" -p "$port" -o IdentitiesOnly=yes user@127.0.0.1 'codex --version'
```

Inspect the auth image entrypoint and do this startup-only `docker run` before the full clone and
install path. If the container exits immediately, read its logs before the cleanup trap removes it;
an image committed from an interactive shell with `ENTRYPOINT ["bash"]` is a common cause.

Confirm the host key is stable across containers as well: dialing `127.0.0.1` should not trigger a
host-key changed warning when a second container reuses the port. If it does, the host keys were not
baked into the base image.
