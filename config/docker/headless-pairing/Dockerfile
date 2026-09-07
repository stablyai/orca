ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

ARG LIBASOUND_PACKAGE=libasound2t64

ENV DEBIAN_FRONTEND=noninteractive

# Why: archive.ubuntu.com mid-sync returns Hash Sum mismatch / wrong-size indexes and stalls per-package fetches; retry with bounded timeouts and drop half-synced lists between attempts.
RUN for attempt in 1 2 3 4 5; do \
      apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update && break; \
      if [ "$attempt" = 5 ]; then exit 100; fi; \
      rm -rf /var/lib/apt/lists/*; sleep 20; \
    done \
  && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
    bash \
    ca-certificates \
    dbus-x11 \
    jq \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    "${LIBASOUND_PACKAGE}" \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    procps \
    util-linux \
    xauth \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash orca

COPY config/docker/headless-pairing/run-appimage-case.sh /usr/local/bin/run-appimage-case

ENTRYPOINT ["/usr/local/bin/run-appimage-case"]
