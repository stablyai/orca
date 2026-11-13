# sandbox-control

The Orca Cloud control plane Worker: workspace lifecycle, the egress credential proxy, environment builds and the golden image. Its routes are listed at the top of `src/index.ts`.

## Typecheck

`pnpm typecheck` runs `scripts/typecheck.mjs`. It fails on any TypeScript diagnostic in this package's own files, and on any diagnostic without a file (a config error).

**Why a raw `tsc --noEmit` shows about 247 diagnostics.** The Worker imports desktop code from `src/shared` (wire types, parsers), so tsc checks those files under this package's options:
- `noUncheckedIndexedAccess`, which the desktop doesn't use, accounts for about 239;
- the Workers globals, which lack the desktop's `window` and `MessageChannel`, account for the rest.

TypeScript can't apply options per file. Those files are type-checked by the root (desktop) typecheck under their own config. So the script counts them, and prints the count on every run so a jump is visible, but doesn't fail on them.

**Why there's an xterm stub.** Desktop settings types import `ITheme` from `@xterm/xterm`, whose typings pull in the DOM library. DOM's `Headers`, streams and `crypto` clash with `@cloudflare/workers-types`. `tsconfig.json` `paths` maps that import to `types/xterm-theme.d.ts`, the theme shape only.
