FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/push-contract/package.json packages/push-contract/package.json
COPY apps/push/package.json apps/push/package.json
RUN pnpm install --frozen-lockfile
COPY packages/push-contract packages/push-contract
COPY apps/push apps/push
RUN pnpm --filter @orca-cloud/push-contract build && pnpm --filter @orca-cloud/push build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/push-contract/package.json packages/push-contract/package.json
COPY apps/push/package.json apps/push/package.json
COPY --from=build /app/packages/push-contract/dist packages/push-contract/dist
COPY --from=build /app/apps/push/dist apps/push/dist
RUN pnpm install --prod --frozen-lockfile --filter @orca-cloud/push...
USER node
EXPOSE 8080
CMD ["node", "apps/push/dist/index.js"]
