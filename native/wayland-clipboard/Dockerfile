FROM ubuntu:20.04
ARG TARGETARCH
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential libwayland-dev python3 \
    $(if [ "$TARGETARCH" = arm64 ]; then echo gcc-x86-64-linux-gnu libc6-dev-amd64-cross; else echo gcc-aarch64-linux-gnu libc6-dev-arm64-cross; fi) \
    && rm -rf /var/lib/apt/lists/*
