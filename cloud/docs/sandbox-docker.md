# Docker in Orca Cloud workspaces (PARITY-DOCKER)

Every Orca Cloud workspace can run Docker. `docker`, `docker compose` and `docker buildx` work as on a laptop. The first time they're used, Docker is installed in the workspace.

## How it runs

- **Installed on first use:** the golden image doesn't ship Docker. Shipping it made every workspace create about 5 s slower at p50, measured on dev with a matched A/B pair.
  - `/opt/orca/bin/docker` (first on PATH, `image/vm/docker`) installs Ubuntu's pinned `docker.io`, `docker-compose-v2` and `docker-buildx` on the first `docker` command in a workspace.
  - It says "Setting up Docker... (first use, about 10 seconds)" and shows a step line. That's about 110 MB to download, measured at 7.5 s on dev.
  - The install is serialised with a lock, so two first commands install once.
  - It stays on the workspace disk.
- **Pins:** the versions are pinned in the shim itself. The Worker installs VM scripts into every workspace on start, so bumping them is a Worker deploy.
- **Rootful:** `dockerd` runs as root inside the workspace's own Firecracker microVM. The VM is the isolation boundary, as it already is for everything agents do (they have `sudo` in it). The socket belongs to the workspace user's group, so `docker` works in the same shell right after the install.
- **Lazy daemon:** the VM has no init system starting services. The shim starts `dockerd` on the first command that needs it, in about 0.3 to 1 s, then runs plain `docker`. `docker --version` and `docker help` don't start it.
- **Config:** `/etc/docker/daemon.json` is written on install, unless one already exists. It sets:
  - overlay2 storage;
  - the `local` log driver with size caps;
  - the `mirror.gcr.io` registry mirror, because Docker Hub's anonymous pull limit is per IP and sandboxes share egress IPs.
- **Failures:** a failed install or start says so in one line and names the log, `/tmp/orca-dockerd.log`.
- **Follow-up (P2):** opting Docker into an environment snapshot, so a team's workspaces start with it installed.

## Sleep and wake

- **What survives:** the install, images, volumes and build cache are on the workspace disk, so they survive sleep and archive.
- **What doesn't:** `dockerd` and running containers stop when the workspace sleeps. After a wake, the next `docker` command starts the daemon again, and containers have to be started again.

## Network and credentials

- **Egress:** the first-use install needs the Ubuntu package archive. Image pulls need the registries. Container traffic leaves through the workspace VM, so the workspace's network policy applies to containers exactly as to the VM.
  - With open egress (#525, the default), both just work.
  - The "limited" preset (SANDBOX_EGRESS_PRESET=limited) needs the Ubuntu archive and registry hosts; a follow-up adds them.
- **Credential hosts:** Orca swaps a placeholder for the real credential on the way out for some hosts: GitHub's git, api.github.com, Orca-account agent sign-ins and egress secrets. Real tokens never enter the VM or containers. Those hosts are TLS-terminated by the provider's proxy, whose certificate containers don't trust by default. A container that must reach one mounts the workspace's proxy CA:

  ```sh
  docker run -v /etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem:/usr/local/share/ca-certificates/orca-proxy.crt:ro \
    my-image sh -c 'update-ca-certificates && ...'
  ```

  Alternatively, point `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` at the mounted file. Public hosts and image pulls don't need it.
- **Planned helper:** a P3 follow-up (`orca docker-run`) will mount the certificate automatically.
- **Metadata:** cloud metadata addresses (169.254.169.254) are refused from containers, as from the VM.

## Turning it off

- **Control-plane switch:** the Worker var `SANDBOX_DOCKER=off` turns Docker off for every workspace at its next start or wake. `orca-sandbox-start` leaves `~/.orca-sandbox/docker.off` and the shim refuses with a plain message instead of installing or starting anything.
- **Default:** unset or `on`, meaning Docker is on.
