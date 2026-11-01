FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
WORKDIR /app
ENV PATH="/opt/pnpm/node_modules/.bin:$PATH"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
RUN npm install --prefix /opt/pnpm --ignore-scripts --no-audit --no-fund "$(node -p 'require("./package.json").packageManager.split("+")[0]')" \
  && npm audit signatures --prefix /opt/pnpm
COPY packages/push-contract/package.json packages/push-contract/package.json
COPY packages/postgres-schema/package.json packages/postgres-schema/package.json
COPY packages/cloud-database/package.json packages/cloud-database/package.json
COPY apps/push/package.json apps/push/package.json
RUN pnpm install --frozen-lockfile
COPY packages/push-contract packages/push-contract
COPY apps/push apps/push
COPY packages/postgres-schema packages/postgres-schema
COPY packages/cloud-database packages/cloud-database
RUN pnpm --filter @orca-cloud/postgres-schema build && pnpm --filter @orca-cloud/push-contract build \
  && pnpm --filter @orca-cloud/cloud-database build \
  && pnpm --filter @orca-cloud/push build

FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
# Pull Alpine security fixes published after the base image was built.
RUN apk upgrade --no-cache
COPY --from=build /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm/node_modules/.bin:$PATH"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/push-contract/package.json packages/push-contract/package.json
COPY packages/postgres-schema/package.json packages/postgres-schema/package.json
COPY packages/cloud-database/package.json packages/cloud-database/package.json
COPY apps/push/package.json apps/push/package.json
COPY --from=build /app/packages/push-contract/dist packages/push-contract/dist
COPY --from=build /app/packages/postgres-schema/dist packages/postgres-schema/dist
COPY --from=build /app/packages/cloud-database/dist packages/cloud-database/dist
COPY --from=build /app/apps/push/dist apps/push/dist
RUN pnpm install --prod --frozen-lockfile --filter @orca-cloud/push... \
  && rm -rf /opt/pnpm /usr/local/lib/node_modules /opt/yarn-* /root/.cache /root/.local \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
EXPOSE 8080
CMD ["node", "apps/push/dist/index.js"]
