FROM node:24.22.1-alpine@sha256:feb76650b7195319268c59cb2d419c732d6c499b13bf5296f16ab59eb1f0a4f3 AS build
WORKDIR /workspace
ENV PATH="/opt/pnpm/node_modules/.bin:$PATH"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
RUN npm install --prefix /opt/pnpm --ignore-scripts --no-audit --no-fund "$(node -p 'require("./package.json").packageManager.split("+")[0]')" \
  && npm audit signatures --prefix /opt/pnpm
COPY apps/relay-fence-broker/package.json apps/relay-fence-broker/package.json
RUN pnpm install --frozen-lockfile
COPY apps/relay-fence-broker apps/relay-fence-broker
RUN pnpm --filter @orca-cloud/relay-fence-broker build

FROM hashicorp/terraform:1.17.0@sha256:4d1b496a256f2989bccdb04b9104a4ede97234b10fba90259e173e905ec4fb58 AS terraform

FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:590.0.0-alpine@sha256:2d6788b06641d02cff063b337dd01a66b71b813bd22fb1fa1b9ee2e7c0ef0743
RUN apk upgrade --no-cache && apk add --no-cache libstdc++
ARG ORCA_RELAY_FENCE_IMAGE_COMMIT
RUN test "$(printf '%s' "${ORCA_RELAY_FENCE_IMAGE_COMMIT}" | grep -E '^[a-f0-9]{40}$')"
ENV NODE_ENV=production
ENV PORT=8080
ENV ORCA_RELAY_FENCE_IMAGE_COMMIT=${ORCA_RELAY_FENCE_IMAGE_COMMIT}
ENV IAC_TOOL=terraform
ENV CLOUDSDK_STORAGE_USE_GCLOUD_CRC32C=false
WORKDIR /workspace
COPY --from=build /usr/local /usr/local
COPY --from=build /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm/node_modules/.bin:$PATH"
COPY --from=terraform /bin/terraform /usr/local/bin/terraform
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/relay-fence-broker/package.json apps/relay-fence-broker/package.json
COPY --from=build /workspace/apps/relay-fence-broker/dist apps/relay-fence-broker/dist
COPY dev/scripts dev/scripts
COPY infra/terraform infra/terraform
COPY apps/relay-fence-broker/requirements.txt /tmp/broker-requirements.txt
RUN /google-cloud-sdk/platform/bundledpythonunixmusl/bin/python3 -m pip install \
    --no-cache-dir --no-deps --require-hashes --upgrade \
    --target /google-cloud-sdk/lib/third_party -r /tmp/broker-requirements.txt \
  && rm -rf /google-cloud-sdk/platform/bq /google-cloud-sdk/platform/gsutil \
    /google-cloud-sdk/platform/bundledpythonunixmusl/lib/python3.14/site-packages/pip* \
    /google-cloud-sdk/platform/bundledpythonunixmusl/lib/python3.14/site-packages/wheel* \
  && rm -f /google-cloud-sdk/bin/gcloud-crc32c /google-cloud-sdk/bin/bq \
    /google-cloud-sdk/bin/gsutil /google-cloud-sdk/platform/bundledpythonunixmusl/bin/pip* \
    /google-cloud-sdk/platform/bundledpythonunixmusl/bin/wheel /tmp/broker-requirements.txt
RUN pnpm install --prod --frozen-lockfile --filter @orca-cloud/relay-fence-broker... \
  && rm -rf /opt/pnpm /usr/local/lib/node_modules /opt/yarn-* /root/.cache /root/.local \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && adduser -D -u 10001 broker \
  && chown -R broker:broker /workspace
USER broker
EXPOSE 8080
CMD ["node", "apps/relay-fence-broker/dist/index.js"]
