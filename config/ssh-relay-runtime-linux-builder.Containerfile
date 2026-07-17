ARG BASE_IMAGE=scratch
FROM ${BASE_IMAGE}

# Why: Rocky 8's default Python 3.6 cannot parse node-gyp 12; Python 3.9 keeps the glibc floor.
ENV NODE_GYP_FORCE_PYTHON=/usr/bin/python3.9

RUN set -eu; \
    dnf module enable -y -q nodejs:20; \
    dnf install -y -q \
      binutils \
      ca-certificates \
      curl \
      findutils \
      gcc-c++ \
      git \
      gnupg2 \
      make \
      nodejs \
      python39 \
      time \
      which \
      xz; \
    test "$(getconf GNU_LIBC_VERSION)" = 'glibc 2.28'; \
    test "$(basename "$(readlink -f /usr/lib64/libstdc++.so.6)")" = 'libstdc++.so.6.0.25'; \
    node -e "if (Number(process.versions.node.split('.')[0]) !== 20) process.exit(1)"; \
    python3.9 -c "import sys; raise SystemExit(sys.version_info[:2] != (3, 9))"; \
    dnf clean all; \
    rm -rf /var/cache/dnf
