# assets/

## `icon-24.png`

Portal submission requires a **24×24, 1-bit monochrome** app icon (per design spec
`docs/superpowers/specs/2026-09-05-even-g2-app-design.md` §11). This file is a real
24×24 PNG, bit depth 1, color type 0 (grayscale) — verified with:

```
file assets/icon-24.png
# PNG image data, 24 x 24, 1-bit grayscale, non-interlaced
```

It renders a simple ring ("O" / orca mark): background pixels are 0 (black), the ring is
1 (white).

Regenerate with the one-shot, dependency-free encoder this was produced from (hand-rolled
PNG chunks + CRC32, `zlib.deflateSync` for the IDAT stream — no image library needed):

```
node make-icon-24.mjs assets/icon-24.png
```

(The generator script itself is not checked into this repo; it is a throwaway ~90-line
Node script using only `node:zlib` and `node:fs`. Recreate it if the icon needs to change:
build a 24×24 boolean grid, pack each row into `ceil(24/8)` MSB-first bytes prefixed by a
`0` filter byte, `deflateSync` the concatenated rows, and wrap in PNG signature + IHDR
(width=24, height=24, bitDepth=1, colorType=0) + IDAT + IEND chunks with standard CRC32.)

Not referenced by `app.json` — the manifest has no icon field; the portal submission flow
picks this asset up separately.
