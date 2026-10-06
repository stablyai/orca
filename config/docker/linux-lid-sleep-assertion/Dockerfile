FROM node:22-bookworm-slim

ENV container=docker
ENV ORCA_BACKGROUND_LAUNCH=1

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd dbus procps \
  && rm -rf /var/lib/apt/lists/*

STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
