FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_PATH=/usr/local/lib/node_modules

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 procps util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global --no-fund --no-audit node-pty@1.1.0

COPY run-case.sh /usr/local/bin/run-daemon-shutdown-descendants
COPY fixture.cjs /opt/daemon-shutdown-descendants/fixture.cjs

ENTRYPOINT ["/usr/local/bin/run-daemon-shutdown-descendants"]
