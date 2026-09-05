FROM ubuntu@sha256:678c6550cc43645e08669028bc177f50be4e7c5b8cca677067b1914d4afc7a03

ENV DEBIAN_FRONTEND=noninteractive
ENV container=docker

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    dbus-x11 \
    iproute2 \
    jq \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libasound2t64 \
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
    python3 \
    systemd \
    util-linux \
    xauth \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash orca

COPY run-update-case.sh /usr/local/bin/run-update-case
COPY mock-feed.py /usr/local/bin/mock-feed

ENTRYPOINT ["/usr/local/bin/run-update-case"]
