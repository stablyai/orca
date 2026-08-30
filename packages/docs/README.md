# @orca/docs

Open-source product documentation for [Orca](https://www.onorca.dev), served at `/docs` (same URL shape as `https://www.onorca.dev/docs`).

This package is a **self-contained Next.js app**. It is intentionally **not** a root monorepo workspace member, so installing Electron app dependencies does not pull Next/fumadocs.

## Local development

```bash
cd packages/docs
pnpm install
pnpm dev
```

Open [http://localhost:3004/docs](http://localhost:3004/docs).

## Production build

```bash
cd packages/docs
pnpm install
pnpm build
pnpm start
```

`pnpm start` serves the production build on port 3004. Paths:

| Path | Purpose |
|------|---------|
| `/` | Redirects to `/docs` |
| `/docs` | Docs index |
| `/docs/...` | Nested doc pages from `content/docs` |
| `/api/search` | Fumadocs search index |

## Layout

- `content/docs/` — MDX pages + `meta.json` navigation
- `public/docs/` — docs-only media (GIFs, posters, screenshots)
- `public/whats-new/` — media assets referenced by docs MDX (subset only)
- `src/app/docs/` — fumadocs routes, OG images
- `src/components/` — docs-scoped chrome (header/footer/search), not marketing site

## Deploy (Vercel)

1. Create a Vercel project with **Root Directory** = `packages/docs`.
2. Framework preset: Next.js. Install/build use this package’s `package.json` (`pnpm install` / `pnpm build`).
3. Set GitHub Actions secrets (optional CI deploy):
   - `VERCEL_TOKEN`
   - `VERCEL_ORG_ID`
   - `VERCEL_PROJECT_ID` (docs project, not the marketing site)
4. Point `www.onorca.dev/docs` at this project (path rewrite or domain root if this project only serves docs).

See `.github/workflows/docs.yml` at the repo root for path-filtered CI.

## Isolation from the desktop app

- Own `package.json` + `pnpm-lock.yaml` under `packages/docs/`
- Not listed in a root `pnpm-workspace.yaml` (the monorepo has none today; mobile is nested similarly)
- Engineering notes remain in repo-root `docs/` — do not confuse with this package
