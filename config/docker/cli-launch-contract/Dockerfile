ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

ARG LIBASOUND_PACKAGE=libasound2t64

ENV DEBIAN_FRONTEND=noninteractive

# Install Electron's link-time libraries without adding a display server or FUSE.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    "${LIBASOUND_PACKAGE}" \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    procps \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash orca

COPY run-cli-case.sh /usr/local/bin/run-cli-case

ENTRYPOINT ["/usr/local/bin/run-cli-case"]
