# Fixture provenance

All fixtures under this directory are derived from two USB captures recorded
against a physical Codex Micro (Work Louder, VID:PID `303a:8360`, firmware
`v0.4.1`) on 2026-07-28:

- `analysis.json` (free-use capture,
  `codex-micro-20260728.pcap`, 389,835 frames / 164.03s)
- `directed-20260728/directed-analysis.json`
  (directed ChatGPT-integration capture,
  `codex-micro-directed-20260728.pcap`, 303,177 packets / 100.34s)

No fixture file contains a device serial number, a raw HID report dump, a
filesystem path, a prompt, or a provider session id. Every fixture stores
already-decoded JSON values (control/action pairs, radar angle/distance,
device status fields, RGB/status command params) or synthetically packed
Report 6 byte frames built from those decoded values — never a byte-for-byte
copy of `codex-micro-20260728.raw.bin` or the `.pcap` files.

## `input-events.json`

Every `CodexMicroControlId` observed in `analysis.json.controls` /
`control_actions`, expanded into press (`action: 1`) / release (`action: 0`)
pairs for buttons and encoder click, and a single step (`action: 2`) entry
for `ENC_CC` / `ENC_CW`. Source: `analysis.json` `controls` and
`control_actions`.

## `radar-events.json`

The 18 `v.oai.rad` events from `analysis.json.radar_events`, renamed from the
wire's short `a`/`d` fields to the shared contract's `angle`/`distance`
fields. Values are unchanged.

## `device-status.json`

`known` reproduces the exact `device.status` response field names captured in
`directed-analysis.json.device_status_responses[0]` (firmware `v0.4.1`,
profile `0`, layer `1`, battery `81`, charging `true`). The device serial
returned alongside that response is intentionally omitted — the shared
contracts and sidecar protocol never carry a serial field.
`unknownFirmware` is a synthetic, clearly-fake variant (`v0.9.9`) used to
exercise the read-only firmware gate; no such firmware was observed on the
wire.

## `runtime-output.json`

`rgbcfgOn`, `rgbcfgOff`, and `thstatus` reproduce representative
`v.oai.rgbcfg` / `v.oai.thstatus` command params from
`directed-analysis.json.rgb_variants` and `.host_commands`. `ack` reproduces
the acknowledgement shape from `directed-analysis.json.host_commands` (the
`id: 547` `v.oai.thstatus` command). Field names (`e`, `b`, `s`, `m`, `c`,
`id`, `sk`, `sa`) are recorded as observed on the wire; they are not given
stronger semantic meaning than the capture supports.

## `interleaved-report6.json`

Reconstructs, as packed `[0x06, 0x02, len, ...payload]` Report 6 byte frames,
the byte-level interleaving documented in
`directed-analysis.json.wire_interleaving_example` (`time_s: 29.732654`): a
`v.oai.thstatus` acknowledgement for request id `547` is cut mid-`"method"`
value by an asynchronous `AG00` press event, then a remaining acknowledgement
fragment follows. The three JSON chunks (`ack_prefix`, `hid_event`,
`ack_suffix`) are generated directly from the example's `report_payload`
string, then packed into individually valid, capacity-checked (`<= 61`
bytes) Report 6 frames padded to 64 bytes. This is a synthetic byte
reconstruction of a real observed event, not a raw capture excerpt.

## Verification

Fixtures were scanned for the captured device serial number after
generation; the scan returned no matches (see Task 1 VERIFY step in
`docs/superpowers/plans/2026-07-28-codex-micro-usb-phase-1.md`).
