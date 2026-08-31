FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

ARG CODEX_VERSION=0.149.1

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && npm install --global "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 orca-worker \
  && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash orca-worker

COPY --chmod=0555 container-worker-report.mjs /usr/local/bin/orca-worker-report

ENV HOME=/home/orca-worker \
  CODEX_HOME=/home/orca-worker/.codex \
  GIT_CONFIG_GLOBAL=/dev/null \
  GIT_CONFIG_NOSYSTEM=1 \
  GIT_TERMINAL_PROMPT=0 \
  GCM_INTERACTIVE=never

USER 10001:10001
WORKDIR /workspace

CMD ["/bin/bash", "-l"]
