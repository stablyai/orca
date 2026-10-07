FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_PATH=/usr/local/lib/node_modules

RUN set -eu \
  && savedAptMark="$(apt-mark showmanual)" \
  && apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 procps util-linux \
  && npm install --global --no-fund --no-audit node-pty@1.1.0 \
  && ptyModule="$(node -e "require('node-pty'); const addon = Object.keys(require.cache).find((path) => path.endsWith('/pty.node')); if (!addon) process.exit(1); process.stdout.write(addon)")" \
  && ldd /usr/local/bin/node "$ptyModule" > /tmp/daemon-runtime-libraries \
  && ! grep -q 'not found' /tmp/daemon-runtime-libraries \
  && apt-mark auto '.*' > /dev/null \
  && { [ -z "$savedAptMark" ] || apt-mark manual $savedAptMark > /dev/null; } \
  && apt-mark manual procps util-linux > /dev/null \
  && awk '/=>/ { so = $(NF-1); if (index(so, "/usr/local/") == 1) next; gsub("^/(usr/)?", "", so); print so }' /tmp/daemon-runtime-libraries \
    | sort -u > /tmp/daemon-runtime-library-paths \
  && xargs -r dpkg-query --search < /tmp/daemon-runtime-library-paths > /tmp/daemon-runtime-packages \
  && cut -d: -f1 /tmp/daemon-runtime-packages | sort -u | xargs -r apt-mark manual \
  && apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false \
  && ldd /usr/local/bin/node "$ptyModule" > /tmp/daemon-runtime-libraries \
  && ! grep -q 'not found' /tmp/daemon-runtime-libraries \
  && ORCA_BACKGROUND_LAUNCH=1 node -e "const pty = require('node-pty'); const terminal = pty.spawn('/bin/sh', ['-c', 'exit 0'], { cwd: '/tmp', env: process.env }); const timer = setTimeout(() => process.exit(1), 5000); terminal.onExit(({ exitCode }) => { clearTimeout(timer); process.exit(exitCode); });" \
  && rm -rf /root/.npm /root/.cache/node-gyp /var/lib/apt/lists/* /tmp/daemon-runtime-libraries /tmp/daemon-runtime-library-paths /tmp/daemon-runtime-packages

COPY run-case.sh /usr/local/bin/run-daemon-shutdown-descendants
COPY fixture.cjs /opt/daemon-shutdown-descendants/fixture.cjs

ENTRYPOINT ["/usr/local/bin/run-daemon-shutdown-descendants"]
