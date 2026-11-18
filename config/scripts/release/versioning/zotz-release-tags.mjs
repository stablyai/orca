// Zotz releases tag v<major>.<minor>.<Orca patch × 100 + build> (docs/zotz/UPDATES-SPEC.md §3), so a
// Zotz tag outranks every Orca tag by number while holding Zotz, not Orca, source.
const ZOTZ_PATCH_MIN = 10_000

/** True for a Zotz release tag (five-digit patch); harnesses that want Orca's releases skip it. */
export function isZotzReleaseTag(tag) {
  const match = /^v\d+\.\d+\.(\d+)$/.exec(tag)
  return match !== null && Number.parseInt(match[1], 10) >= ZOTZ_PATCH_MIN
}
