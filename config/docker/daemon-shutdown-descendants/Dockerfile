FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV ORCA_BACKGROUND_LAUNCH=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends libstdc++6 procps util-linux \
  && rm -rf /var/lib/apt/lists/*

COPY --chmod=755 bun-runtime /usr/local/bin/bun-runtime
COPY run-case.sh /usr/local/bin/run-daemon-shutdown-descendants
COPY fixture.cjs /opt/daemon-shutdown-descendants/fixture.cjs

ENTRYPOINT ["/usr/local/bin/run-daemon-shutdown-descendants"]
