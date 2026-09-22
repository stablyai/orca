# @orca/docs

This package contains the product documentation and public media intended to
ship alongside Orca's source code.

Open-source product documentation for [Orca](https://www.onorca.dev), served at `/docs` (same URL shape as `https://www.onorca.dev/docs`).

This package is a **self-contained Next.js app**. It is intentionally **not** a root monorepo workspace member, so installing Electron app dependencies does not pull Next/fumadocs.

## Local development

```bash
cd docs/site
pnpm --ignore-workspace install
pnpm --ignore-workspace dev
```

Open [http://localhost:3004/docs](http://localhost:3004/docs).

## Production build

```bash
cd docs/site
pnpm --ignore-workspace install
pnpm --ignore-workspace build
pnpm --ignore-workspace start
```

`pnpm start` serves the production build on port 3004. Paths:

| Path               | Purpose                              |
| ------------------ | ------------------------------------ |
| `/`                | Redirects to `/docs`                 |
| `/docs`            | Docs index                           |
| `/docs/...`        | Nested doc pages from `content/docs` |
| `/docs/api/search` | Fumadocs search index                |
| `/docs/og/...`     | Per-page Open Graph image route      |

## Layout

- `content/docs/` — MDX pages + `meta.json` navigation
- `public/docs/` — docs-only media, logo, and favicon (GIFs, posters, screenshots)
- `src/app/docs/` — fumadocs routes, OG images
- `src/components/` — docs-scoped chrome (header/footer/search), not marketing site

## Updating content

Treat the documentation tree as a deliberate publication boundary. Before
importing source material, review the diff for internal references, credentials,
third-party media rights, and feature/version claims, then copy only approved
pages and assets. Keep the app shell and deployment configuration in this
repository so a docs-only pull request can be reviewed and built independently.

## Same-domain routing

The docs app is a separate Vercel project (the **docs zone**) and keeps the
public `/docs` URL namespace. The marketing site remains the default zone for
`www.onorca.dev`; configure its Next/Vercel proxy with these `beforeFiles`
rewrites, replacing `DOCS_ORIGIN` with the docs project's production URL:

```js
return {
  beforeFiles: [
    {
      source: '/docs',
      destination: `${DOCS_ORIGIN}/docs`
    },
    {
      source: '/docs/:path*',
      destination: `${DOCS_ORIGIN}/docs/:path*`
    },
    {
      source: '/docs-static/:path*',
      destination: `${DOCS_ORIGIN}/docs-static/:path*`
    }
  ]
}
```

`/docs-static` is the docs zone's `assetPrefix`; it prevents `_next` asset
collisions with the marketing zone. Keep the rewrites in the default zone and
use ordinary `<a>` links when navigating between zones. Do not add
`basePath: '/docs'` to this app: its route tree and Fumadocs `baseUrl` already
include `/docs`, so doing so would publish `/docs/docs/...` URLs. If a future
deployment needs `basePath`, first move the route tree to an unprefixed
`src/app/[[...slug]]` shape and update every generated/link URL together.

## Deploy (Vercel)

1. Create a Vercel project with **Root Directory** unset (`.`). The workflow
   invokes Vercel from `docs/site`, so that directory is already the deployment
   root; setting it again would resolve `docs/site/docs/site`. Leave automatic
   Git deployments disabled so this workflow remains the only deployment path.
2. Framework preset: Next.js. Use `pnpm --ignore-workspace install --frozen-lockfile` for install and `pnpm --ignore-workspace build` for build; this package has its own lockfile beside the root workspace.
3. Set GitHub Actions secrets (required by the production deploy job):
   - `VERCEL_TOKEN`
   - `VERCEL_ORG_ID`
   - `VERCEL_PROJECT_ID` (docs project, not the marketing site)
4. Protect the `docs-production` GitHub environment with required reviewers and
   custom deployment branch policies for `main` and `v*` tags. The release-cut
   dispatch runs from `main`; the direct published-release fallback runs from a
   stable tag, while the workflow still authorizes only exact stable tags.
5. Prepare the three rewrites above in the `www.onorca.dev` marketing project,
   but leave them disabled until the docs deployment is verified. A Vercel
   custom domain cannot delegate only `/docs` by itself; the default zone must
   proxy both page/API/media requests and `/docs-static` assets. Keep the
   marketing project's old docs routes available for rollback during the
   transition; putting the proxy rules in `beforeFiles` ensures they win once
   enabled.
6. Deploy a stable desktop tag that contains `docs/site`, verify the docs
   origin, then enable the marketing rewrites. Tags cut before this package was
   added cannot bootstrap the docs project because production intentionally
   checks out the tag's exact commit. Remove the old marketing docs routes in a
   follow-up after the proxy is stable.

`.github/workflows/docs.yml` runs credential-free checks for every pull request.
It intentionally does not deploy PR previews: a PR-controlled build must not
receive Vercel credentials. A maintainer can add a separate trusted preview
workflow later. Production deploys only from an authorized stable desktop release: an exact
`vX.Y.Z` tag, a published non-prerelease release, and the
`github-actions[bot]` release author. Manual dispatch must run from the default
branch and name an existing release that meets the same checks. Mobile,
prerelease, draft, and human-authored releases are skipped. Fork pull requests
remain build-only because GitHub does not expose deployment secrets to fork
jobs.

## Versioning

`versioning.config.ts` keeps the current unversioned `/docs` URLs stable while
reserving `content/versions/<id>` for future snapshots. Versioned routes are not
live yet; when they are needed, add the corresponding loader/routes and a
version entry. The release workflow can then deploy them without a trigger
change.

## Isolation from the desktop app

- Own `package.json` + `pnpm-lock.yaml` under `docs/site/`
- Not listed in the root `pnpm-workspace.yaml`; install with `pnpm --ignore-workspace`
- Engineering notes remain in repo-root `docs/` — do not confuse with this package
