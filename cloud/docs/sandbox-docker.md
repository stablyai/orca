# Docker in Orca Cloud workspaces (PARITY-DOCKER)

Every Orca Cloud workspace has Docker. `docker`, `docker compose` and `docker buildx` work as on a laptop.

## How it runs

- **Where:** the golden image ships Ubuntu's `docker.io`, `docker-compose-v2` and `docker-buildx`, pinned in `image/golden-image.manifest.json`.
- **Rootful:** `dockerd` runs as root inside the workspace's own Firecracker microVM. The VM is the isolation boundary, as it already is for everything agents do (they have `sudo` in it). Rootless Docker would add no isolation and slower networking.
- **Lazy:** the VM has no init system starting services. `/opt/orca/bin/docker` (first on PATH, `image/vm/docker`) starts `dockerd` on the first command that needs it, in about 0.3 s, then runs plain `docker`.
- **Config:** `/etc/docker/daemon.json` sets:
  - overlay2 storage;
  - the `local` log driver with size caps;
  - the `mirror.gcr.io` registry mirror, because Docker Hub's anonymous pull limit is per IP and sandboxes share egress IPs. Docker Hub itself is the fallback.

## Sleep and wake

- **What survives:** images, volumes and build cache are on the workspace disk, so they survive sleep and archive.
- **What doesn't:** `dockerd` and running containers stop when the workspace sleeps. After a wake, the next `docker` command starts the daemon again (about 0.7 s), and containers have to be started again.

## Network and credentials

- **Egress:** container traffic leaves through the workspace VM, so the workspace's network policy applies to containers exactly as to the VM. The default allowlist includes the registries `CONTAINER_REGISTRY_HOSTS` in `src/network-policy.ts`: mirror.gcr.io, Docker Hub and GHCR.
- **Credential hosts:** Orca swaps a placeholder for the real credential on the way out for some hosts: GitHub's git, api.github.com, Orca-account agent sign-ins and egress secrets. Real tokens never enter the VM or containers. Those hosts are TLS-terminated by the provider's proxy, whose certificate containers don't trust by default. A container that must reach one mounts the workspace's proxy CA:

  ```sh
  docker run -v /etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem:/usr/local/share/ca-certificates/orca-proxy.crt:ro \
    my-image sh -c 'update-ca-certificates && ...'
  ```

  Alternatively, point `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` at the mounted file. Public hosts and image pulls don't need it.
- **Planned helper:** a P3 follow-up (`orca docker-run`) will mount the certificate automatically.
- **Metadata:** cloud metadata addresses (169.254.169.254) are refused from containers, as from the VM.

## Turning it off

- **Control-plane switch:** the Worker var `SANDBOX_DOCKER=off` turns Docker off for every workspace at its next start or wake. `orca-sandbox-start` leaves `~/.orca-sandbox/docker.off` and the shim refuses with a plain message instead of starting `dockerd`.
- **Default:** unset or `on`, meaning Docker is on.

## Cost (spike, 2026-11-13, node:24 base)

- **Image size:** about 400 MB larger.
- **Create time:** the golden rotation measures workspace create time at p50 and p95 before and after on dev. A p50 regression above 2 s goes to the coordinator before the golden is promoted.
