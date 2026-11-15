# Build context: cloud/apps (the relay imports sandbox-control's codex-paths.ts, the shared path pinning).
FROM node:24-slim
WORKDIR /app
COPY sandbox-control/src/codex-paths.ts sandbox-control/src/codex-paths.ts
COPY chatgpt-relay/package.json chatgpt-relay/package.json
COPY chatgpt-relay/src chatgpt-relay/src
WORKDIR /app/chatgpt-relay
ENV NODE_ENV=production
USER node
CMD ["node", "src/index.ts"]
