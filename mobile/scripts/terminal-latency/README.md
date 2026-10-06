# Phone terminal latency under impaired networks

Measures what a phone user sees from the iOS app's terminal over bad networks: key press to
echo, how a streaming answer arrives, and how scrolling behaves, against real Claude Code and
Codex (on a local stub API, no account) and `less`, on each of the travel-network profiles in
`tests/e2e/helpers/network-travel-profiles.ts`. The network impairment is packet-level
(tc/netem) and sits on the container's own interface, so the phone's TCP connection runs
through it end to end. macOS only (iOS Simulator, OrbStack).

## One-time setup

1. Build and install the app on a simulator (`mobile/scripts/start-emulator.mjs` or the usual
   dev build), with the latency probes compiled in:

   ```sh
   EXPO_PUBLIC_ORCA_TERMINAL_LATENCY_PROBES=1 pnpm exec expo start --dev-client --port 8081
   ```

   With the flag, the app prints `[lat] ...` lines through Metro (see
   `mobile/src/terminal/terminal-latency-probes.ts`); without it, nothing is compiled in.
2. Start the host: `scripts/terminal-latency/start-phone-latency-host.sh <orca-linux-arm64.AppImage>`.
   It builds `tests/e2e/fixtures/agent-terminal-host`, runs an Orca server at the container's IP,
   opens the three terminals, and prints a pairing link.
3. Open the pairing link on the simulator, choose "Open sessions in the terminal", and open the
   `demo-repo` session so the three tabs are on screen. Attach the emulator helper:
   `orca emulator attach <udid>`.

For the relay topology, run a forwarder on its own Docker network that points at the host
(`tests/e2e/fixtures/impaired-network-link`'s `link-end` with `FORWARD_TO=<host ip>:6800`),
pair the phone to the forwarder's address instead, and pass `--container <forwarder>
--network <its network>` below; shape the forwarder-to-host leg separately with
`impairContainerNetwork` on the host container's bridge network.

## Running

```sh
cd mobile
pnpm exec tsx scripts/terminal-latency/run-phone-latency-matrix.ts \
  --container orca-phone-host --label direct --runs 10 \
  --metro-log <metro.log> --out <results.jsonl>
pnpm exec tsx scripts/terminal-latency/summarize-phone-latency.ts <results.jsonl>
```

Each run, for each profile (interleaved, so drift spreads over all of them): on Claude Code and
then Codex, type a 22-character line (20 keys timed), submit and watch a 40-line answer (with the profile's outage as one
cut 3 s in), a long drag then a tap, a hard flick; then a drag and a flick in `less`. About
85 s per profile and run on a good link, 160 s on the subway profile. `--profiles` narrows the
set (names as in the profiles file, plus `unshaped`), `--first-run` resumes.

The summary prints Markdown tables: the median over runs of each per-run number with the
2nd-lowest to 2nd-highest run in parentheses, which for 10 runs brackets the true median about
98% of the time without assuming a distribution. The raw `.jsonl` keeps every probe line, so
other questions can be answered without re-running.

## Reading the probes

`phone-latency-metrics.ts` documents the lines. Key to echo is a `key` line to the first `rx`
whose typed-line field shows that character. Scroll positions are `rx` lines whose first
marker changed. A tap is delivered when a `tx` carrying a mouse press follows its `touchstart`.
