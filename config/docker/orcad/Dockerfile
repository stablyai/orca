# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.22.1-bookworm-slim
FROM ${NODE_IMAGE} AS node

FROM quay.io/pypa/manylinux_2_28_x86_64@sha256:407f771c51a2c3e83ebe5a7970b4289ead3a6db21d9b9c089168775cad11d328 AS native-amd64
FROM quay.io/pypa/manylinux_2_28_aarch64@sha256:c22ffd129ac99a8a42d1f2c2f4e88a9089288dd9ee987a7092da1c7dc48f27a9 AS native-arm64

ARG TARGETARCH
FROM native-${TARGETARCH} AS build
COPY --from=node /usr/local/ /usr/local/
ENV CI=1 ORCA_BACKGROUND_LAUNCH=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    ORCA_PNPM_GLOBAL_VIRTUAL_STORE=0 CC=gcc CXX=g++ \
    PYTHON=/opt/python/cp312-cp312/bin/python3
WORKDIR /source
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY config/pnpmfile.cjs config/
COPY config/patches/ config/patches/
COPY src/packages/ src/packages/
COPY native/windows-registry/ native/windows-registry/
COPY native/windows-security/ native/windows-security/
RUN corepack enable pnpm && corepack install && pnpm install --frozen-lockfile --ignore-scripts
COPY mobile/package.json mobile/pnpm-lock.yaml mobile/pnpm-workspace.yaml mobile/
COPY mobile/patches/ mobile/patches/
COPY mobile/packages/ mobile/packages/
RUN pnpm --dir mobile install --frozen-lockfile --ignore-scripts
COPY src/ src/
COPY native/ native/
COPY resources/ resources/
COPY mobile/ mobile/
COPY config/ config/
ARG ORCAD_SOURCE_COMMIT
ARG ORCAD_SOURCE_DIRTY=false
ARG ORCAD_SOURCE_FINGERPRINT
RUN ORCAD_BUILT_SOURCE_FINGERPRINT="$(node config/docker/orcad/source-metadata.mjs)" \
    && pnpm --dir mobile run postinstall && pnpm build:mobile-web \
    && ORCAD_SOURCE_COMMIT=${ORCAD_SOURCE_COMMIT} pnpm build:orcad \
    && ORCAD_BUILT_SOURCE_FINGERPRINT=${ORCAD_BUILT_SOURCE_FINGERPRINT} node config/docker/orcad/build-support.mjs

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git openssh-client procps tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/orca /workspaces /run/orca /opt/orca/providers \
    && chown node:node /var/lib/orca /workspaces /run/orca /opt/orca/providers \
    && rm -f /etc/machine-id && ln -s /var/lib/orca/machine-id /etc/machine-id \
    && ln -s /opt/orca/providers/bin/claude /usr/local/bin/claude \
    && ln -s /opt/orca/providers/bin/codex /usr/local/bin/codex \
    && ln -s /opt/orca/providers/bin/gemini /usr/local/bin/gemini
COPY --from=build /source/out/orcad/ /opt/orca/orcad/
COPY --from=build /source/out/runtimes/ /opt/orca/runtimes/
COPY --from=build /source/out/orcad-docker/ /opt/orca/docker/
ENV HOME=/home/node ORCA_USER_DATA=/var/lib/orca XDG_CONFIG_HOME=/home/node/.config \
    XDG_DATA_HOME=/home/node/.local/share XDG_STATE_HOME=/home/node/.local/state \
    PATH=/opt/orca/providers/bin:/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin \
    ORCA_BACKGROUND_LAUNCH=1 NODE_ENV=production DISABLE_AUTOUPDATER=1 \
    ORCAD_PAIRING_ADDRESS=127.0.0.1:6768
ARG CLAUDE_CODE_VERSION=2.1.310
ARG CODEX_VERSION=
ARG GEMINI_CLI_VERSION=
USER node
RUN node /opt/orca/docker/install-providers.cjs
ARG ORCAD_SOURCE_COMMIT
ARG ORCAD_SOURCE_DIRTY=false
ARG ORCAD_SOURCE_FINGERPRINT
LABEL org.opencontainers.image.title="Orca Node server" \
    org.opencontainers.image.source="https://github.com/stablyai/orca" \
    org.opencontainers.image.revision=${ORCAD_SOURCE_COMMIT} \
    io.orca.source.dirty=${ORCAD_SOURCE_DIRTY} \
    io.orca.source.fingerprint=${ORCAD_SOURCE_FINGERPRINT}
WORKDIR /workspaces
EXPOSE 6768
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=15s --start-period=120s --retries=3 \
    CMD ["node", "/opt/orca/docker/healthcheck.cjs"]
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/orca/docker/entrypoint.cjs"]
