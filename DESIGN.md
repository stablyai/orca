# Design — MCode "Test Bench"

<!-- impeccable:design-schema 1 -->
<!-- Ground truth recorded from the built token world in
     src/renderer/src/assets/main.css. Direction seed: f13c0254 (assigned #5).
     Direction contract lives as the opening comment of :root in main.css. -->

## World

**Test Bench.** MCode is a calibrated measurement instrument for an agent fleet:
every agent is a channel, every run a trace. The world refuses the AI-default
near-black-plus-neon look and the stark-white SaaS dashboard alike.

- **Dark ("bench at night"):** deep cool slate — ground `#12151B`, panels
  `#1A1F28`, raised `#242B3A`, ink `#E9EDF2`. The default scene: a developer at
  a desk in low light, long sessions.
- **Light ("faceplate"):** warm putty enamel — ground `#F1F0EB`, cards
  `#FAF9F6`, ink `#191C21`. Powder-coated instrument, not a paper sheet.
- Both themes are first-class; status hues keep their identity across flips.

## Channel system (signature)

Four-trace oscilloscope coding carries semantics everywhere:

| Channel | Hue (dark / light) | Meaning |
|---|---|---|
| Ch2 cyan | `#53C6D8` / `#0E7C90` | interactive: focus rings, links, AI-action accent, selection tint |
| Ch1 amber | `#E3B341` / `#8A6A00` | working / in-progress |
| Ch3 magenta | `#E06CA8` / `#C2317F` | agent asks you (replaces the old orange) |
| Ch4 green | `#63D48E` / `#1A7F42` | success / done |

Charts (`--chart-1..5`) and git-graph lanes (`--git-graph-lane-1..5`) draw from
the trace palette (+ violet spare `#9E86FF`), so branch color == channel color.

## Type

- Geist variable (bundled) for UI — workhorse face, correct for Operate mode.
- Mono only for code, data, measurement. `.readout` utility: mono + tabular
  numerals for counts, durations, diffs — values tick in place, no jitter.
- Radius: machined `0.5rem` (down from 0.625).

## Materials and rules

- Chrome stays calm; character lives in micro-details: tabular readouts,
  channel-colored LEDs and rings, trace-cyan selection.
- `.graticule` (12px faint grid) is reserved for measuring surfaces — charts,
  git graph — never text or chrome surfaces.
- Elevation: borders carry structure; shadows stay soft and offset.
- Contrast floor: body text ≥4.5:1 in both themes (muted `#9BA5B4` on `#1A1F28`
  dark, `#5B6270` on `#FAF9F6` light).

## Do not

- Do not introduce glow/neon edges (the category rut this world refuses).
- Do not use the graticule decoratively outside measurement surfaces.
- Do not recode channel semantics (cyan/amber/magenta/green) per-feature.
- Do not swap Geist for a display face in Operate surfaces.
