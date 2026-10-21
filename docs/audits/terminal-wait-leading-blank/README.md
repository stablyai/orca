# Terminal wait tail-window termination

`startOfLastNonBlankLines` loops indefinitely if its input begins with a newline and contains fewer nonblank rows than requested. Once the backward cursor reaches zero, JavaScript `lastIndexOf` clamps its negative start position to zero and rediscovers the same first newline. The cursor stops advancing.

The fix ends the scan when the cursor reaches zero and returns the existing short-tail offset, zero. It changes no prompt patterns or readiness rules. The ordinary finite-window selection cases retain their previous offsets.

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/terminal-wait-leading-blank/reproduce.mjs > /tmp/orca-terminal-wait-leading-blank.json
```

The script bundles actual source and reverses only the two-line termination change for the baseline. Each case runs in an isolated child with a two-second deadline and 128 MiB heap limit. The parent confirms child termination; no app windows open. Five direct helper/detector cases time out before and return after. A sufficient-row control and actual headless terminal projection controls pass in both variants. Results include source hashes, platform, timing, and an explicit v1.4.198 helper comparison.

The regression suite uses a separate child for inputs that could hang the worker. It also tests exact row offsets with intervening whitespace, trailing blanks and tails shorter than the requested window. Fifty helper/detector tests pass.

## Production and incident limits

The helper is byte-identical in v1.4.198. However, all inspected main/provider/renderer visible-screen projection routes pass through `visibleNonBlankTerminalLines`, and ordinary retained-tail construction removes blank rows too. The real headless producer control confirms this filtering. Calling the public detector directly with a leading newline is therefore insufficient evidence that those production routes trigger the defect.

A clipped 300-character preview can start at a newline. The preview fallback also preserves it when passed empty retained rows; the proof records both facts. It does not establish an actual application lifecycle that combines that fallback with a live detector call. That remains unproven.

This is a defensive termination fix found during the memory audit. The loop itself does not allocate a growing collection. No memory magnitude was measured, and it is not an attribution of #19768's main-process growth or #19831's application-scope OOM.
