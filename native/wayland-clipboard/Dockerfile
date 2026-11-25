FROM ubuntu:20.04
ARG TARGETARCH
RUN sed -i -E \
    -e 's#http://(archive|security)\.ubuntu\.com/ubuntu#http://mirrors.mit.edu/ubuntu#g' \
    -e 's#http://ports\.ubuntu\.com/ubuntu-ports#http://mirrors.mit.edu/ubuntu-ports#g' \
    /etc/apt/sources.list \
    && printf 'Acquire::Retries "2";\nAcquire::http::Timeout "15";\n' > /etc/apt/apt.conf.d/99-orca-mirror \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential libwayland-dev python3 libgtk-3-0 xvfb xclip \
    $(if [ "$TARGETARCH" = arm64 ]; then echo gcc-x86-64-linux-gnu libc6-dev-amd64-cross; else echo gcc-aarch64-linux-gnu libc6-dev-arm64-cross; fi) \
    && rm -rf /var/lib/apt/lists/*
