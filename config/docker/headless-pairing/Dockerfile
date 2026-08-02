ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

ARG LIBASOUND_PACKAGE=libasound2t64

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
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
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash orca

COPY config/docker/headless-pairing/run-appimage-case.sh /usr/local/bin/run-appimage-case

ENTRYPOINT ["/usr/local/bin/run-appimage-case"]
