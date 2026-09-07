FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/relay-contract/package.json packages/relay-contract/package.json
COPY apps/relay/package.json apps/relay/package.json
RUN pnpm install --frozen-lockfile
COPY packages/relay-contract packages/relay-contract
COPY apps/relay apps/relay
RUN pnpm --filter @orca-cloud/relay-contract build && pnpm --filter @orca-cloud/relay build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/relay-contract/package.json packages/relay-contract/package.json
COPY apps/relay/package.json apps/relay/package.json
COPY --from=build /app/packages/relay-contract/dist packages/relay-contract/dist
COPY --from=build /app/apps/relay/dist apps/relay/dist
RUN pnpm install --prod --frozen-lockfile --filter @orca-cloud/relay...
USER node
EXPOSE 8080
CMD ["node", "apps/relay/dist/index.js"]
