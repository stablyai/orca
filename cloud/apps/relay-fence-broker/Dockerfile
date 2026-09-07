FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/relay-fence-broker/package.json apps/relay-fence-broker/package.json
RUN pnpm install --frozen-lockfile
COPY apps/relay-fence-broker apps/relay-fence-broker
RUN pnpm --filter @orca-cloud/relay-fence-broker build

FROM hashicorp/terraform:1.15.8 AS terraform

FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:slim
ARG ORCA_RELAY_FENCE_IMAGE_COMMIT
RUN test "$(printf '%s' "${ORCA_RELAY_FENCE_IMAGE_COMMIT}" | grep -E '^[a-f0-9]{40}$')"
ENV NODE_ENV=production
ENV PORT=8080
ENV ORCA_RELAY_FENCE_IMAGE_COMMIT=${ORCA_RELAY_FENCE_IMAGE_COMMIT}
ENV IAC_TOOL=terraform
WORKDIR /workspace
COPY --from=build /usr/local /usr/local
COPY --from=terraform /bin/terraform /usr/local/bin/terraform
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/relay-fence-broker/package.json apps/relay-fence-broker/package.json
COPY --from=build /workspace/apps/relay-fence-broker/dist apps/relay-fence-broker/dist
COPY dev/scripts dev/scripts
COPY infra/terraform infra/terraform
RUN corepack enable \
  && pnpm install --prod --frozen-lockfile --filter @orca-cloud/relay-fence-broker... \
  && useradd --create-home --uid 10001 broker \
  && chown -R broker:broker /workspace
USER broker
EXPOSE 8080
CMD ["node", "apps/relay-fence-broker/dist/index.js"]
