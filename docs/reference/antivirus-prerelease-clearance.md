# Antivirus clearance for future releases

Orca collects a steady stream of antivirus and EDR false positives — see the
tracking issue for the current grouping. This document covers the part of that
problem worth engineering effort: **stopping the next release from being
flagged.**

Clearing a *historic* release is explicitly not a goal. A user sitting on a
flagged build should update to a cleared one, not wait for a vendor to whitelist
a version we no longer ship. Retroactive submissions cost the same effort per
vendor and expire the moment we cut a new version.

For the behavioural side of the problem — the process-tree shapes EDR scores,
which no whitelist fixes — read
[`windows-edr-posture.md`](./windows-edr-posture.md) instead. This document is
about file verdicts on the bytes we ship.

## The two mechanisms, and only one of them scales

**Sample submission** clears one build. You send the flagged file to a vendor's
analyst portal, they confirm it is clean, and the verdict is dropped from their
next definition update. This is reactive and per-release: cutting a new version
produces new bytes, new hashes, and a fresh chance of the same heuristic firing.
Doing this every release, across every vendor, is not sustainable.

**Signer and product whitelisting** clears every future build. The vendor
records the publisher identity or enrolls the product in a dynamic allowlist, and
subsequent releases inherit that trust without another submission. Enrollment is
one-time work per vendor, and it is the only lever that scales with our release
cadence.

Prefer enrollment. Use submission only to clear a live incident while enrollment
is pending, and only for a release users are actually expected to install.

## Prerequisites that make enrollment possible

None of these programs will accept an unsigned or anonymous binary, so these
come first:

1. **Every shipped PE is Authenticode-signed, and CI fails the release if not.**
   Done as of v1.4.217 — the release workflow requires a valid SignPath
   Foundation signature on the inner binaries and no longer fails open.
2. **Every shipped PE carries real provenance** — company, product, version,
   description, and an explicit `asInvoker` manifest. An anonymous binary scores
   worse than an identified one, and several portals reject submissions that
   carry no version metadata.
3. **One stable signer identity.** Vendor allowlists key on the certificate
   subject. Rotating signers resets accrued reputation, so a certificate change
   is a re-enrollment event, not a transparent swap.

## Vendor programs

Enrollment state is deliberately left as a task here rather than asserted — fill
each in as it is confirmed, and record the account that owns it so a lapsed
enrollment is traceable.

| Vendor                    | Mechanism                                                                    | Scope                    | State |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------ | ----- |
| **VirusTotal**            | Monitor — paid; builds rescanned daily, developer and vendor both notified     | ~70 engines at once      | TODO  |
| **Microsoft**             | Defender Security Intelligence submission, as a software developer            | Defender, Defender FP EP | TODO  |
| **Microsoft**             | Trusted Signing, or an EV certificate, for SmartScreen and Smart App Control  | Reputation gates         | TODO  |
| **Kaspersky**             | Whitelist Program — vendors submit builds for the Dynamic Allowlist           | Endpoint, all platforms  | TODO  |
| **Trend Micro**           | Certified Safe Software Service — pre-release software whitelisting           | Endpoint, Virus Buster   | TODO  |
| **Bitdefender**           | False-positive submission for software vendors                                | Endpoint, ATD            | TODO  |
| **Avast / AVG / Norton**  | Gen Digital false-positive and whitelisting channels                          | Consumer suites          | TODO  |
| **ESET**                  | False-positive sample submission                                             | Endpoint                 | TODO  |
| **Tencent iOA**           | No public developer channel found; needs a support relationship               | iOA, macOS and Windows   | TODO  |

VirusTotal Monitor is the highest-leverage single entry, because it is the only
channel built for exactly this workflow: uploads sit in a private store, get
rescanned daily against every engine's current signatures, and when one flags a
file **both we and that vendor are notified automatically**. Pre-publish upload
is a supported use, which is precisely the future-release posture we want. It is
a paid service, monetised on developers and free to the antivirus vendors.

Be honest about its limit: VirusTotal states plainly that Monitor is not a free
pass to get a file whitelisted. Vendors sometimes keep a detection. What it
reliably buys is *early notice and a real contact path* instead of discovering a
verdict from a user's issue report weeks later.

Do not treat a plain VirusTotal *scan* as equivalent. A scan tells us a verdict
exists; Monitor is what routes it to someone who can drop it.

If the subscription is not worth it, the free fallback is the community-maintained
false-positive contact directory (`yaronelh/False-Positive-Center` on GitHub),
which collects the submission addresses and forms each vendor actually reads.
That replaces the hardest part of a submission — finding the right contact — but
keeps the per-release effort that Monitor removes.

## Where this lands in the release flow

The check belongs at RC time, not after a stable cut — a verdict discovered after
publication is a verdict users already hit.

`config/scripts/scan-release-artifacts-antivirus.mjs` reports the current
detection state of built artifacts by hash. Run it against an RC's artifacts, and
treat any engine verdict as a release-blocking question rather than an automatic
stop: these are third-party ML classifiers, so a hard gate on their output would
fail the release for reasons outside our control. Read the report, decide, and
submit if the flagged build is one we intend to ship.

The script looks up hashes by default and never transmits artifact bytes. Passing
`--upload` sends the file to VirusTotal, which distributes samples to partner
vendors — that is the intended outcome for clearance work, but it is a
publication, so it stays opt-in and out of any automated path.

## What not to do

- **Do not ask users to add exclusions** as the resolution. It suppresses the
  symptom on one machine, and in several reports here the exclusion did not even
  hold because the detection was behavioural rather than path-based.
- **Do not dispute a verdict without a sample.** Every report worth acting on in
  this project came with a hash that we verified bit-identical to the published
  release asset. That verification is what makes a submission credible.
- **Do not chase a vendor whose detection we cannot reproduce or name.** Route
  those back to the reporter for the detection string and the exact flagged path
  first.
