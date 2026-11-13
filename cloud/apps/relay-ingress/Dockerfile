# Relay ingress proxy (src/proxy.ts). Build from cloud/: docker build -f apps/relay-ingress/Dockerfile .
# Runtime config: see src/index.ts. Certificate, key and secret are mounted files, never baked in.
FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
WORKDIR /app
ENV PATH="/opt/pnpm/node_modules/.bin:$PATH"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
RUN npm install --prefix /opt/pnpm --ignore-scripts --no-audit --no-fund "$(node -p 'require("./package.json").packageManager.split("+")[0]')" \
  && npm audit signatures --prefix /opt/pnpm
COPY packages/relay-contract/package.json packages/relay-contract/package.json
COPY apps/relay-ingress/package.json apps/relay-ingress/package.json
RUN pnpm install --frozen-lockfile --filter @orca-cloud/relay-ingress...
COPY packages/relay-contract packages/relay-contract
COPY apps/relay-ingress apps/relay-ingress
RUN pnpm --filter @orca-cloud/relay-contract build && pnpm --filter @orca-cloud/relay-ingress build

FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk upgrade --no-cache
# The proxy has no runtime dependencies beyond the contract's built output.
COPY --from=build /app/packages/relay-contract/package.json packages/relay-contract/package.json
COPY --from=build /app/packages/relay-contract/dist packages/relay-contract/dist
COPY --from=build /app/apps/relay-ingress/package.json apps/relay-ingress/package.json
COPY --from=build /app/apps/relay-ingress/dist apps/relay-ingress/dist
RUN mkdir -p apps/relay-ingress/node_modules/@orca-cloud \
  && ln -s ../../../../packages/relay-contract apps/relay-ingress/node_modules/@orca-cloud/relay-contract \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
# 443 needs CAP_NET_BIND_SERVICE as non-root; the default listens on 8443 behind the load balancer.
ENV PORT=8443 HEALTH_PORT=8081 HEALTH_HOST=0.0.0.0
EXPOSE 8443 8081
STOPSIGNAL SIGTERM
CMD ["node", "apps/relay-ingress/dist/index.js"]
