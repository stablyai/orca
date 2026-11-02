ARG BASE_IMAGE=debian:bookworm-slim
FROM node:22-bookworm-slim AS node
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    systemd systemd-sysv libpam-systemd dbus dbus-user-session procps util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 1100 --create-home --shell /bin/sh orca-repro

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY process-fixture.cjs run-cases.cjs terminal-scope-cases.cjs /opt/daemon-scope-lifetime/

STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
