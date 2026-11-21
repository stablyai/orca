FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
WORKDIR /app
ENV PATH="/opt/pnpm/node_modules/.bin:$PATH"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches patches
COPY apps/relay-auth/package.json apps/relay-auth/package.json
RUN npm install --prefix /opt/pnpm --ignore-scripts --no-audit --no-fund "$(node -p 'require("./package.json").packageManager.split("+")[0]')" && pnpm install --frozen-lockfile --filter @orca-cloud/relay-auth
COPY apps/relay-auth/src apps/relay-auth/src
COPY apps/relay-auth/tsconfig*.json apps/relay-auth/
RUN pnpm --filter @orca-cloud/relay-auth build && pnpm deploy --legacy --config.allowUnusedPatches=true --filter @orca-cloud/relay-auth --prod /release
FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
RUN apk upgrade --no-cache && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /release ./
ENV NODE_ENV=production PORT=8080 ORCA_AUTH_DATA_DIR=/data
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
