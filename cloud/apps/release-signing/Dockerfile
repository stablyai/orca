FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/release-signing/package.json apps/release-signing/package.json
RUN pnpm install --frozen-lockfile --filter @orca-cloud/release-signing...
COPY apps/release-signing apps/release-signing
RUN pnpm --filter @orca-cloud/release-signing build
RUN pnpm --filter @orca-cloud/release-signing deploy --legacy --prod /app

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
