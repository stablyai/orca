# syntax=docker/dockerfile:1.7
# Boot-twice harness image: the golden image's provisioning, run in a container instead of a Vercel
# build sandbox. boot-twice.ts writes the build context (this file, provision-golden.sh and
# provision.env, the same env build-golden-image.ts passes) and then boots the result twice.
# Base: Ubuntu 26.04 (what vercel/sandbox/node:24 is) with Node 24 and passwordless sudo for `ubuntu`, which is what the provision
# script expects from the managed image it normally runs on.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node

FROM ubuntu:26.04@sha256:065aa8626841f16057b78b027b464cd59c4fac36c204c72dcbf48d66f5fa8a96 AS base
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
  && apt-get update -qq \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates sudo >/dev/null \
  && rm -rf /var/lib/apt/lists/* \
  && printf 'ubuntu ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/ubuntu && chmod 0440 /etc/sudoers.d/ubuntu

# The golden build: provision, then wipe identity, exactly as buildGoldenImage runs them.
FROM base AS golden
USER ubuntu
WORKDIR /home/ubuntu
COPY --chown=ubuntu:ubuntu provision-golden.sh provision.env /tmp/golden/
RUN set -a && . /tmp/golden/provision.env && set +a \
  && { bash /tmp/golden/provision-golden.sh >/tmp/golden/provision.out || { tail -n 40 /tmp/golden/provision.out; exit 1; }; } \
  && sudo install -D -m 0644 /tmp/golden/provision.out /var/lib/orca-boot-twice/provision-report.json \
  && /opt/orca/bin/orca-image-wipe

# Harness scaffolding only (outside /opt/orca): the fake per-boot kernel boot id, and a local repo
# for the workspace prelude to clone so the first boot needs no GitHub.
FROM golden AS harness
USER root
COPY boot-twice-init /usr/local/sbin/boot-twice-init
RUN chmod 0755 /usr/local/sbin/boot-twice-init \
  && git init -q --bare -b main /srv/fixture.git \
  && tmp="$(mktemp -d)" && git -C "$tmp" init -q -b main \
  && printf 'boot twice fixture\n' >"$tmp/README.md" && git -C "$tmp" add README.md \
  && git -C "$tmp" -c user.name=fixture -c user.email=fixture@orca.invalid commit -q -m fixture \
  && git -C "$tmp" push -q /srv/fixture.git main && rm -rf "$tmp" \
  && chown -R ubuntu:ubuntu /srv/fixture.git
CMD ["/usr/local/sbin/boot-twice-init"]
